// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The connect burst's SHAPE, over a real socket (#635). wsHub.test.ts covers the
// individual frame builders as functions; none of them can prove the thing that
// actually matters here — that `backlog-complete` arrives after every buffer
// frame the burst is going to send. That is an ordering property of the whole
// synchronous burst, so it needs a real client reading real frames in order: a
// function-level test would still pass if the terminal frame were sent first,
// which is precisely the bug it exists to rule out.
//
// Its own DB (and its own user) rather than a describe block in
// wsHub.upgrade.test.ts, because seeding networks and buffers to make the burst
// interesting would change what those upgrade tests see on connect.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-burst');

let server: http.Server;
let userId: number;
let networkId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let url: string;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('burstuser').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'burstuser',
  });
  networkId = net!.id;

  // No live IRC connection in tests, so this network takes the offline path —
  // the same one a paused or disconnected account hits, and the one whose
  // buffers `snapshot.networks[].channels` reports as empty regardless.
  const seed = (target: string, text: string): void => {
    if (!target.startsWith(':')) buffers.ensureExists(userId, networkId, target);
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text,
      self: false,
    });
  };
  seed('#lurker', 'hello');
  seed('bob', 'a dm');
  seed(`:server:${networkId}`, 'connection notice');

  server = http.createServer();
  attachWsHub(server, 'burst-test-secret');
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

// Opens a socket and collects frames until `backlog-complete` arrives, then
// hands back everything including it. `send` runs once the burst is in, so a
// caller can drive a second burst (the in-band resync) on the same socket.
function collectBurst(send?: Frame): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(userId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const frames: Frame[] = [];
    let resent = false;
    // A missing terminal frame is the failure this suite is about, so time out
    // rather than hang — and report what DID arrive, since "which frames came
    // before it gave up" is the whole diagnostic. Deliberately under vitest's
    // 5000ms default testTimeout (vitest.config.ts sets none): at parity the
    // two timers race, and vitest winning replaces this frame list with a bare
    // "Test timed out" exactly when the list is worth having.
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no backlog-complete; got: ${frames.map((f) => f.kind).join(', ')}`));
    }, 3000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      if (frame.kind !== 'backlog-complete') return;
      if (send && !resent) {
        // Second burst requested: keep collecting, and stop at ITS terminator.
        resent = true;
        ws.send(JSON.stringify(send));
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(frames);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('connect burst terminator (#635)', () => {
  it('ends the burst with backlog-complete, after every buffer frame', async () => {
    const frames = await collectBurst();

    // Terminal means terminal: nothing the burst had to say comes after it.
    expect(frames.at(-1)!.kind).toBe('backlog-complete');
    expect(frames.filter((f) => f.kind === 'backlog-complete')).toHaveLength(1);
    expect(frames[0].kind).toBe('snapshot');

    // Every buffer the user owns landed BEFORE the terminator — which is what
    // makes absence provable for anything that didn't.
    const targets = frames.filter((f) => f.kind === 'backlog').map((f) => f.target);
    expect(targets).toEqual(expect.arrayContaining(['#lurker', 'bob', `:server:${networkId}`]));

    // The claim a by-key client leans on: a buffer with no frame by the time
    // the terminator arrives is not open (see the closed-buffer case below for
    // why that's the honest phrasing). Nothing else in the burst supports it —
    // note that the snapshot reports this network's channels as empty even
    // though #lurker is right there in the frames.
    expect(targets).not.toContain('#never-joined');
    const snapshot = frames[0] as { networks: Array<{ channels: unknown[] }> };
    expect(snapshot.networks[0].channels).toEqual([]);
  });

  it('withholds a frame for a CLOSED buffer, whose history the server still holds', async () => {
    // The sharp edge of "absence is proof": a closed buffer is dropped from the
    // enumeration, so it looks identical to one that never existed — while its
    // backlog sits intact server-side, one open-buffer away. A client that
    // purged local history on a missing frame would be destroying a copy of
    // something the server never forgot, so the doc says render-absent but
    // don't destroy, and this pins the behavior that claim rests on.
    const buffers = await import('../db/buffers.js');
    const { insertMessage, hasMessageForTarget } = await import('../db/messages.js');
    buffers.ensureExists(userId, networkId, '#closed');
    insertMessage({
      networkId,
      target: '#closed',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'still here',
      self: false,
    });
    buffers.close(userId, networkId, '#closed');

    const frames = await collectBurst();
    expect(frames.filter((f) => f.kind === 'backlog').map((f) => f.target)).not.toContain(
      '#closed',
    );

    // Same instant, same server: the history the burst declined to mention.
    expect(buffers.isClosed(userId, networkId, '#closed')).toBe(true);
    expect(hasMessageForTarget(networkId, '#closed')).toBe(true);
  });

  it('terminates an in-band snapshot resync too, not just the connect burst', async () => {
    // A visibility-return resync ships a fresh burst on a live socket. It has
    // the same "is this buffer gone?" problem, so it gets the same terminator.
    const frames = await collectBurst({ type: 'snapshot' });
    expect(frames.filter((f) => f.kind === 'backlog-complete')).toHaveLength(2);
    expect(frames.at(-1)!.kind).toBe('backlog-complete');
  });

  // #627: the cap has to arrive on the socket every client already opens. A
  // client that has to make a REST call to learn it will hardcode a guess
  // instead — which is exactly what lurker-ios did.
  it('carries the effective upload cap on the snapshot frame', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(userId, 'uploads.image.max_upload_mb', 42);
    try {
      const [snapshot] = (await collectBurst()) as unknown as [{ maxUploadBytes?: number }];
      expect(snapshot.maxUploadBytes).toBe(42 * 1024 * 1024);
    } finally {
      const { deleteUserSetting } = await import('../db/settings.js');
      deleteUserSetting(userId, 'uploads.image.max_upload_mb');
    }
  });
});

// #627: the snapshot's number is only current until the user edits their cap.
// Their own edit already fans out a `settings` frame, so the recomputed cap rides
// it rather than leaving them compressing against a stale value until reconnect.
describe('upload cap on the settings frame (#627)', () => {
  it('re-sends the effective cap when the user changes their own cap', async () => {
    const settingsService = (await import('./settingsService.js')).default;
    const { deleteUserSetting } = await import('../db/settings.js');
    const { token } = createSession(userId);

    const frame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('no settings frame arrived'));
      }, 3000);
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as Record<string, unknown>;
        // Change the setting only once the connect burst is done, so the frame
        // we're waiting for can't be confused with anything in the burst.
        if (f.kind === 'backlog-complete') {
          settingsService.update(userId, { 'uploads.image.max_upload_mb': 7 });
          return;
        }
        if (f.kind !== 'settings') return;
        clearTimeout(timer);
        ws.close();
        resolve(f);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    try {
      expect(frame.maxUploadBytes).toBe(7 * 1024 * 1024);
    } finally {
      deleteUserSetting(userId, 'uploads.image.max_upload_mb');
    }
  });
});
