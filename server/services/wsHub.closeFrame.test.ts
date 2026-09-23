// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `close-buffer` frame, through a real socket.
//
// Closing is more than flipping a flag: the row closes, a pin and a favorite on
// it come off (the client renders those sections as pins ∩ open buffers, so one
// left behind is an invisible orphan — #112, #405), a DM's peer stops being
// tracked, the draft goes, and every one of the user's devices hears about it.
// All of that moved into wsHub.closeBuffer when the bouncer needed the whole of
// a close, and a refactor is only as good as what proves it preserved behaviour
// — this frame had no test of its own, so nothing did.
//
// Two real sockets for one user, because half the claims here are about what
// the OTHER device was told, which a mock socket can't see.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-closeframe');

let server: http.Server;
let userId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let buffers: typeof import('../db/buffers.js');
let pinBuffer: typeof import('../db/pinnedBuffers.js').pinBuffer;
let listPinnedForUserNetwork: typeof import('../db/pinnedBuffers.js').listPinnedForUserNetwork;
let favoriteBuffer: typeof import('../db/favoriteBuffers.js').favoriteBuffer;
let listFavoritesForUser: typeof import('../db/favoriteBuffers.js').listFavoritesForUser;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  buffers = await import('../db/buffers.js');
  ({ pinBuffer, listPinnedForUserNetwork } = await import('../db/pinnedBuffers.js'));
  ({ favoriteBuffer, listFavoritesForUser } = await import('../db/favoriteBuffers.js'));
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('closeframeuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'closeframeuser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, 'closeframe-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

type Frame = Record<string, unknown>;

interface Client {
  ws: WebSocket;
  frames: Frame[];
  send(frame: Frame): void;
  waitFor(pred: (f: Frame) => boolean, what: string): Promise<Frame>;
  close(): void;
}

async function connect(): Promise<Client> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  });
  // The opening burst has to drain first, or its frames get mistaken for answers.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no backlog-complete')), 3000);
    waiters.push({
      pred: (f) => f.kind === 'backlog-complete',
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    });
  });
  frames.length = 0;
  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: (pred, what) =>
      new Promise<Frame>((resolve, reject) => {
        const existing = frames.find(pred);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for ${what}; got: ${frames.map((f) => f.kind).join(', ')}`,
              ),
            ),
          3000,
        );
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
    close: () => ws.close(),
  };
}

const closedFor = (target: string) => (f: Frame) =>
  f.kind === 'buffer-closed' && f.target === target;

describe('the close-buffer frame', () => {
  it('closes the row and tells the user’s other device', async () => {
    buffers.ensureOpen(userId, networkId, '#plain', { kind: 'channel' });
    const a = await connect();
    const b = await connect();

    a.send({ type: 'close-buffer', networkId, target: '#plain' });
    const onB = await b.waitFor(closedFor('#plain'), 'buffer-closed on the other device');

    expect(buffers.getState(userId, networkId, '#plain')).toBe('closed');
    // The id is resolved before the close, so the frame can still carry it.
    expect(onB.bufferId).toBe(buffers.getBuffer(userId, networkId, '#plain')?.id);
    a.close();
    b.close();
  });

  it('takes the pin and the favorite off with it', async () => {
    // Both sections render as (pins | favorites) ∩ open buffers, so one left on
    // a closed row is invisible here and still there in our copy — the two
    // diverge, and the orphan outlives whatever put it there.
    buffers.ensureOpen(userId, networkId, '#decorated', { kind: 'channel' });
    pinBuffer(userId, networkId, '#decorated');
    favoriteBuffer(userId, networkId, '#decorated');
    const a = await connect();
    const b = await connect();

    a.send({ type: 'close-buffer', networkId, target: '#decorated' });
    await b.waitFor(closedFor('#decorated'), 'buffer-closed');
    await b.waitFor((f) => f.kind === 'pins-changed', 'pins-changed');
    await b.waitFor((f) => f.kind === 'favorites-changed', 'favorites-changed');

    expect(listPinnedForUserNetwork(userId, networkId)).not.toContain('#decorated');
    expect(listFavoritesForUser(userId).map((e) => e.target)).not.toContain('#decorated');
    a.close();
    b.close();
  });

  it('closes a DM without looking for a channel to part', async () => {
    // The other half of the branch: a DM close untracks the peer instead, and
    // must not go looking for membership of something that was never a channel.
    buffers.ensureOpen(userId, networkId, 'bob', { kind: 'dm' });
    const a = await connect();

    a.send({ type: 'close-buffer', networkId, target: 'bob' });
    await a.waitFor(closedFor('bob'), 'buffer-closed');

    expect(buffers.getState(userId, networkId, 'bob')).toBe('closed');
    a.close();
  });

  it('refuses to close a server pseudo-buffer', async () => {
    // It's the per-network log, not a conversation. Guarded before the close,
    // so nothing is fanned out either.
    const serverTarget = `:server:${networkId}`;
    const a = await connect();

    a.send({ type: 'close-buffer', networkId, target: serverTarget });
    // Something that DOES answer, to prove the close was ignored rather than
    // merely slower than this assertion.
    buffers.ensureOpen(userId, networkId, '#after', { kind: 'channel' });
    a.send({ type: 'close-buffer', networkId, target: '#after' });
    await a.waitFor(closedFor('#after'), 'the close that should work');

    expect(a.frames.some(closedFor(serverTarget))).toBe(false);
    expect(buffers.getState(userId, networkId, serverTarget)).not.toBe('closed');
    a.close();
  });
});
