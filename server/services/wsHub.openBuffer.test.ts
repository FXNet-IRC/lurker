// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The read/write seam: `{type:'history', mode:'latest'}` vs `open-buffer`
// (WS_PROTOCOL_FIXES #1).
//
// Every claim here is about a SIDE EFFECT — whether a persisted flag moved, and
// what the user's OTHER devices were told — which is exactly what a
// function-level test can't see. `handleOpenBuffer` can be called directly with a
// mock socket (wsHub.test.ts does), but a mock socket has no siblings, so the
// fan-out is invisible to it. So: two real sockets for one user, and assertions
// on what each of them received.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-openbuffer');

let server: http.Server;
let userId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let buffers: typeof import('../db/buffers.js');
let insertMessage: typeof import('../db/messages.js').insertMessage;
let setUserPaused: typeof import('../db/users.js').setUserPaused;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ setUserPaused } = await import('../db/users.js'));
  const { createNetwork } = await import('../db/networks.js');
  ({ insertMessage } = await import('../db/messages.js'));
  buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('openbufferuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'openbufferuser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, 'openbuffer-test-secret');
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

function seed(target: string, text: string): void {
  buffers.ensureExists(userId, networkId, target);
  insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick: 'bob',
    text,
    self: false,
  });
}

/** One connected client, recording every frame it receives after the burst. */
interface Client {
  ws: WebSocket;
  frames: Frame[];
  send(frame: Frame): void;
  /** Resolve once a frame matching `pred` arrives, or reject on timeout. */
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
  // The burst has to drain before anything below, or its frames get mistaken
  // for answers.
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

/** Let anything the server was going to push actually arrive. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

const isBacklogFor = (target: string) => (f: Frame) => f.kind === 'backlog' && f.target === target;

const isHistoryFor = (target: string) => (f: Frame) =>
  f.kind === 'history' && f.target === target && f.mode === 'latest';

describe('hydration is a pure read', () => {
  it('serves a CLOSED buffer’s history and leaves it closed', async () => {
    // The bug the split exists for. Hydrating through `open-buffer` reopened the
    // row, so merely opening a screen on a stale row resurrected the buffer on
    // every one of the user's devices — and now that an open is announced, it
    // would do so loudly.
    seed('#closedbuf', 'still here');
    buffers.close(userId, networkId, '#closedbuf');
    expect(buffers.isClosed(userId, networkId, '#closedbuf')).toBe(true);

    const client = await connect();
    client.send({ type: 'history', mode: 'latest', networkId, target: '#closedbuf' });
    const reply = await client.waitFor(isHistoryFor('#closedbuf'), 'history');

    expect((reply.events as Frame[]).map((e) => e.text)).toEqual(['still here']);
    // The whole point: reading it changed nothing.
    expect(buffers.isClosed(userId, networkId, '#closedbuf')).toBe(true);
    client.close();
  });

  it('answers for a target with no row and no history, rather than staying silent', async () => {
    // A client that spends one request per buffer can't tell "no reply yet" from
    // "never coming", so a silent branch is a permanent loading spinner (#635).
    const client = await connect();
    client.send({ type: 'history', mode: 'latest', networkId, target: '#never-existed' });
    const reply = await client.waitFor(isHistoryFor('#never-existed'), 'history');

    expect(reply.events).toEqual([]);
    // ...and answering didn't mint anything.
    expect(buffers.getBuffer(userId, networkId, '#never-existed')).toBeUndefined();
    client.close();
  });

  it('resolves a divergently-cased target to the stored row', async () => {
    // `messages.target` is BINARY-collated TEXT and rows keep the network's casing, so an
    // exact match against the caller's casing finds NOTHING — which surfaces as a hydrated,
    // permanently blank buffer rather than an error. Newly load-bearing because hydration
    // moved onto this verb: a client can hold a key it built before the row existed (iOS
    // synthesizes one from the typed name when joining) and its own store folds case, so the
    // mismatch is invisible to it.
    seed('#CasedBuf', 'canonical row');
    const client = await connect();
    client.send({ type: 'history', mode: 'latest', networkId, target: '#casedbuf' });
    const reply = await client.waitFor((f) => f.kind === 'history', 'history');

    expect((reply.events as Frame[]).map((e) => e.text)).toEqual(['canonical row']);
    // Answered under the stored casing, so a client keying by target converges on the row.
    expect(reply.target).toBe('#CasedBuf');
    client.close();
  });

  it('is invisible to the user’s other devices', async () => {
    seed('#quiet', 'a line');
    const reader = await connect();
    const other = await connect();

    reader.send({ type: 'history', mode: 'latest', networkId, target: '#quiet' });
    await reader.waitFor(isHistoryFor('#quiet'), 'history');
    await settle();

    // A read is nobody else's business. `open-buffer` announces; this must not.
    expect(other.frames).toEqual([]);
    reader.close();
    other.close();
  });

  it('works for a paused account, unlike the write verb', async () => {
    // The paused gate already encodes this seam: it blocks `open-buffer` and not
    // `history`. So a client that hydrated through the write verb couldn't show a
    // paused user anything at all — `account paused`, then a loading spinner
    // forever. This pins both halves, since it's the pairing that makes the
    // split load-bearing rather than tidy.
    seed('#paused', 'readable while paused');
    setUserPaused(userId, true);
    try {
      const client = await connect();
      client.send({ type: 'history', mode: 'latest', networkId, target: '#paused' });
      const reply = await client.waitFor(isHistoryFor('#paused'), 'history');
      expect((reply.events as Frame[]).map((e) => e.text)).toEqual(['readable while paused']);

      client.send({ type: 'open-buffer', networkId, target: '#paused' });
      const err = await client.waitFor((f) => f.kind === 'error', 'error');
      expect(err.text).toBe('account paused');
      client.close();
    } finally {
      setUserPaused(userId, false);
    }
  });
});

describe('open-buffer — the announced write', () => {
  it('reopens for the requester and tells the other devices, without moving their focus', async () => {
    seed('#shared', 'history');
    buffers.close(userId, networkId, '#shared');

    const opener = await connect();
    const other = await connect();
    opener.send({ type: 'open-buffer', networkId, target: '#shared' });

    // The requester gets the content it asked for, plus the reply that resolves
    // canonical casing and tells it to focus.
    const mine = await opener.waitFor(isBacklogFor('#shared'), 'backlog');
    expect((mine.events as Frame[]).length).toBe(1);
    await opener.waitFor(
      (f) => f.kind === 'buffer-opened' && f.target === '#shared',
      'buffer-opened',
    );
    expect(buffers.isClosed(userId, networkId, '#shared')).toBe(false);

    // The other device learns the buffer exists — as a SHELL. That's what keeps
    // `buffer-opened` from reading as "focus this" over there: the row is
    // already present when it lands, so the frame is a state signal, and the
    // device fetches the contents only if the user actually goes there.
    const theirs = await other.waitFor(isBacklogFor('#shared'), 'shell backlog');
    expect(theirs.mode).toBe('shell');
    expect(theirs.events).toEqual([]);
    await other.waitFor(
      (f) => f.kind === 'buffer-opened' && f.target === '#shared',
      'buffer-opened',
    );

    opener.close();
    other.close();
  });

  it('does not echo the announcement back to the socket that asked', async () => {
    seed('#echo', 'x');
    buffers.close(userId, networkId, '#echo');

    const opener = await connect();
    opener.send({ type: 'open-buffer', networkId, target: '#echo' });
    await opener.waitFor((f) => f.kind === 'buffer-opened', 'buffer-opened');
    await settle();

    // Exactly one of each: the real backlog and one buffer-opened. A shell
    // arriving here would un-hydrate the buffer the requester just received.
    expect(opener.frames.filter((f) => f.kind === 'backlog')).toHaveLength(1);
    expect(opener.frames.filter((f) => f.kind === 'buffer-opened')).toHaveLength(1);
    expect(opener.frames.find((f) => f.kind === 'backlog')!.mode).not.toBe('shell');
    opener.close();
  });
});
