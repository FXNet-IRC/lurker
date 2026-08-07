// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Backpressure detection against a REAL socket pair.
//
// wsHub.test.ts drives `dropIfBackpressured` as a function with a hand-built
// stand-in, which proves the decision logic but assumes the thing the whole
// design rests on: that `ws.bufferedAmount` actually reports what we think —
// that it climbs when the peer stops reading, and falls when it starts again.
// Every version of this feature that was wrong was wrong about THAT, not about
// the arithmetic, so it's worth a test that can't be satisfied by a mock.
//
// Runs a real WebSocketServer over a real TCP loopback and pauses the client's
// underlying socket to simulate a peer whose receive window has closed. No hub,
// no DB rows, no IRC — the unit under test is one exported function and the
// socket it reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { setupTestDb } from '../test-utils/testApp.js';

// wsHub pulls in the db layer on import; point it at a throwaway file so this
// can never touch real data.
const testDb = setupTestDb('wshub-backpressure');

let dropIfBackpressured: typeof import('./wsHub.js').dropIfBackpressured;
let wss: WebSocketServer;
let url: string;

// Comfortably past MAX_BUFFERED_BYTES (8 MiB) once a few of these are queued.
const CHUNK = 'x'.repeat(1024 * 1024);
const CAP = 8 * 1024 * 1024;
const GRACE = 30_000;

beforeAll(async () => {
  ({ dropIfBackpressured } = await import('./wsHub.js'));
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterAll(() => {
  wss.close();
  testDb.cleanup();
});

/** A connected pair: the server's view of the socket, and the client's. */
async function connectedPair(): Promise<{ server: WebSocket; client: WebSocket }> {
  const serverSocket = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const client = new WebSocket(url);
  await new Promise<void>((resolve) => client.once('open', () => resolve()));
  return { server: await serverSocket, client };
}

/** Queue frames until the socket is genuinely over the cap. */
function fillPastCap(server: WebSocket): void {
  while (server.bufferedAmount <= CAP) {
    for (let i = 0; i < 4; i++) server.send(CHUNK);
  }
}

/**
 * The streak bookkeeping wsHub hangs off the socket. These are real `ws`
 * sockets rather than `LurkerWebSocket`s (the hub isn't in play here), so the
 * field isn't on the declared type — read it through a narrow cast rather than
 * widening the production interface for a test.
 */
function streakOf(ws: WebSocket): unknown {
  return (ws as unknown as { backpressure?: unknown }).backpressure;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('backpressure against a real socket', () => {
  it('bufferedAmount climbs when the peer stops reading and falls when it resumes', async () => {
    // The premise the whole feature rests on. If this ever fails, the detector
    // is measuring nothing and every threshold above it is theatre.
    const { server, client } = await connectedPair();
    try {
      // Stop reading: the kernel receive window closes, the server's writes stop
      // completing, and `ws` queues them in the Node heap.
      client.pause();
      fillPastCap(server);
      expect(server.bufferedAmount).toBeGreaterThan(CAP);

      // Start reading again. A healthy-but-slow peer looks exactly like this.
      client.resume();
      client.on('message', () => {});
      const drained = await waitFor(() => server.bufferedAmount === 0);
      expect(drained).toBe(true);
    } finally {
      client.terminate();
      server.terminate();
    }
  }, 20_000);

  it('does not drop a socket that is still over the cap but has drained something', async () => {
    // The regression that killed two earlier designs: "big for a while" is not
    // "stuck". A real slow link sits over the cap for far longer than the grace
    // period while behaving perfectly, and dropping it there sends it into a
    // reconnect loop against an identical payload.
    //
    // Staging a *sustained* slow drain on loopback isn't possible — the transport
    // is bimodal, moving either one frame or the entire queue per turn (measured;
    // see the preconditions below, which fail loudly rather than letting this pass
    // vacuously if that ever changes). So this proves the one step that matters:
    // real bytes left the socket, it's still over the cap, and the elapsed time
    // alone would have condemned it. The multi-step version lives in
    // wsHub.test.ts against injected values.
    const { server, client } = await connectedPair();
    try {
      client.pause();
      // Fill well past the cap so a single frame's worth of drain leaves us
      // comfortably above it.
      while (server.bufferedAmount <= CAP * 4) server.send(CHUNK);
      const filled = server.bufferedAmount;

      expect(dropIfBackpressured(server, 0)).toBe(false); // start watching

      // Consume a counted handful of frames, then stop reading again. Counting
      // receipts rather than waiting a duration is what makes this deterministic:
      // a timed window on loopback either moves nothing or the entire queue.
      let received = 0;
      client.on('message', () => {
        received += 1;
        if (received >= 3) client.pause();
      });
      client.resume();
      await waitFor(() => received >= 3);
      // A little more may already have been in flight when pause() landed; the
      // fill is deep enough that it doesn't matter.
      const afterDrain = server.bufferedAmount;
      // Preconditions — if either fails the scenario didn't happen and the
      // assertion below would be meaningless.
      expect(afterDrain, 'expected some bytes to drain').toBeLessThan(filled);
      expect(afterDrain, 'expected to still be over the cap').toBeGreaterThan(CAP);

      // Exactly at the grace boundary, and deliberately so: any later and the
      // staleness rule ("we haven't looked in a while, so the streak proves
      // nothing") would restart the streak and this would pass without ever
      // reaching the progress check. At exactly GRACE the streak is still
      // current AND fully elapsed, so the ONLY thing that can save this socket
      // is having drained. Verified by mutation: reverting the progress check
      // fails this assertion.
      expect(dropIfBackpressured(server, GRACE)).toBe(false);
    } finally {
      client.terminate();
      server.terminate();
    }
  }, 20_000);

  it('drops a socket whose peer never reads', async () => {
    // The case the feature exists for: the window is closed, nothing moves, and
    // the queue is memory we will never get back.
    const { server, client } = await connectedPair();
    try {
      client.pause();
      fillPastCap(server);
      const queued = server.bufferedAmount;

      expect(dropIfBackpressured(server, 0)).toBe(false); // start watching
      // Still paused, so nothing has drained — no new low, streak intact.
      expect(server.bufferedAmount).toBeGreaterThanOrEqual(queued - 1);
      expect(dropIfBackpressured(server, GRACE)).toBe(true);

      // terminate() must actually tear the socket down — a close() would queue
      // behind the stuck bytes and leave them resident for ws's 30s closeTimeout.
      const closed = await waitFor(() => server.readyState === WebSocket.CLOSED);
      expect(closed).toBe(true);
    } finally {
      client.terminate();
      server.terminate();
    }
  }, 20_000);

  it('clears the streak once the socket is back under the cap', async () => {
    const { server, client } = await connectedPair();
    try {
      client.pause();
      fillPastCap(server);
      dropIfBackpressured(server, 0);
      expect(streakOf(server)).toBeDefined();

      client.resume();
      client.on('message', () => {});
      await waitFor(() => server.bufferedAmount <= CAP);
      expect(dropIfBackpressured(server, GRACE * 5)).toBe(false);
      expect(streakOf(server)).toBeUndefined();
    } finally {
      client.terminate();
      server.terminate();
    }
  }, 20_000);
});
