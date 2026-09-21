// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — dccListener → dccConfig → userCapabilities → db/index opens
// the real DB at module load unless DATABASE_PATH is redirected before then.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import { openDccListener, activeDccListenerCount, resetDccListeners } from './dccListener.js';

// ⚠⚠ Below 32768, deliberately. A fixed test port must sit OUTSIDE the OS
// ephemeral range, which the kernel hands out as the LOCAL port of every
// outgoing connection — any concurrent test's client socket can land on it,
// and this listen then fails with EADDRINUSE. Linux's range is 32768-60999
// and macOS's 49152-65535, so the old 458xx ports were safe on a Mac and
// collided under CI's parallel suite on Linux (reproduced in Docker, Node 24:
// EADDRINUSE 127.0.0.1:45822). Keep any replacement below 32768.
const MIN = 24820;
const MAX = 24829;

beforeEach(() => {
  process.env.LURKER_DCC_LISTEN_BIND = '127.0.0.1';
  process.env.LURKER_DCC_LISTEN_PORT_MIN = String(MIN);
  process.env.LURKER_DCC_LISTEN_PORT_MAX = String(MAX);
  resetDccListeners();
});

afterEach(() => {
  delete process.env.LURKER_DCC_LISTEN_BIND;
  delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
  delete process.env.LURKER_DCC_LISTEN_PORT_MAX;
});

// Land Date.now() on a millisecond whose remainder mod `span` is `wanted`, so
// the allocator's rotating start is deterministic.
function pinRotation(span: number, wanted: number): void {
  const base = 1_000_000_000_000;
  vi.setSystemTime(new Date(base + ((wanted - base) % span) + span));
  expect(Date.now() % span).toBe(wanted);
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('connect', () => resolve(s));
    s.on('error', reject);
  });
}

describe('openDccListener', () => {
  it('binds a port in range and resolves accepted with the first inbound socket', async () => {
    const handle = await openDccListener({ timeoutMs: 2000 });
    expect(handle.port).toBeGreaterThanOrEqual(MIN);
    expect(handle.port).toBeLessThanOrEqual(MAX);
    expect(activeDccListenerCount()).toBe(1);

    const client = await connect(handle.port);
    const server = await handle.accepted;
    expect(server).toBeInstanceOf(net.Socket);

    // Bytes flow both ways over the accepted socket.
    const got = new Promise<string>((res) => server.once('data', (d) => res(d.toString())));
    client.write('ping');
    expect(await got).toBe('ping');

    server.destroy();
    client.destroy();
    // Port released once the one connection was accepted (server closed).
    expect(activeDccListenerCount()).toBe(0);
  });

  it('rejects accepted on timeout and releases the port', async () => {
    const handle = await openDccListener({ timeoutMs: 120 });
    await expect(handle.accepted).rejects.toThrow(/timed out/);
    expect(activeDccListenerCount()).toBe(0);
  });

  it('close() rejects a pending accept and frees the port', async () => {
    const handle = await openDccListener({ timeoutMs: 5000 });
    handle.close();
    await expect(handle.accepted).rejects.toThrow(/closed/);
    expect(activeDccListenerCount()).toBe(0);
    handle.close(); // idempotent
  });

  it('allocates distinct ports for concurrent listeners', async () => {
    const a = await openDccListener({ timeoutMs: 1000 });
    const b = await openDccListener({ timeoutMs: 1000 });
    expect(a.port).not.toBe(b.port);
    expect(activeDccListenerCount()).toBe(2);
    a.close();
    b.close();
    await expect(a.accepted).rejects.toThrow(/closed/);
    await expect(b.accepted).rejects.toThrow(/closed/);
  });

  // The rotating start exists so concurrent offers don't all probe the same low
  // port first. The subtlety is that `free` has a GAP once we hold a mid-range
  // port: rotating over port VALUES (free[0] + offset) then picks a number that
  // isn't in the list at all, `indexOf` returns -1, and `slice(-1)` silently
  // collapses the candidates to the single highest port. Rotating over INDICES
  // is the fix, and only a gapped free set can tell the two apart.
  it('rotates over free-list indices, not port values, when the range has a gap', async () => {
    vi.useFakeTimers();
    try {
      // First listener takes MIN+5, leaving free = [MIN..MIN+4, MIN+6..MAX].
      pinRotation(MAX - MIN + 1, 5);
      const held = await openDccListener({ timeoutMs: 5000 });
      expect(held.port).toBe(MIN + 5);

      // Nine ports remain. Offset 5 indexes MIN+6; the old value-based rotation
      // would compute MIN+5, miss (it's held), and fall back to MAX.
      pinRotation(MAX - MIN, 5);
      const next = await openDccListener({ timeoutMs: 5000 });
      expect(next.port).toBe(MIN + 6);
      expect(next.port).not.toBe(MAX);

      held.close();
      next.close();
      await expect(held.accepted).rejects.toThrow(/closed/);
      await expect(next.accepted).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  // The range doubles as the concurrency cap, so EVERY port in it has to be
  // reachable no matter where the rotation starts. Rotating over port VALUES
  // rather than indices breaks this the moment the free set has a gap.
  it('can allocate every port in the range, then refuses', async () => {
    const handles = [];
    for (let i = 0; i <= MAX - MIN; i++) handles.push(await openDccListener({ timeoutMs: 1000 }));
    const ports = handles.map((h) => h.port).toSorted((a, b) => a - b);
    expect(ports).toEqual(Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i));
    await expect(openDccListener({ timeoutMs: 1000 })).rejects.toThrow(/no free DCC port/);
    for (const h of handles) h.close();
    await Promise.all(handles.map((h) => expect(h.accepted).rejects.toThrow(/closed/)));
    expect(activeDccListenerCount()).toBe(0);
  });

  // A port held by ANOTHER process is invisible to our in-use set, so the bind
  // fails with EADDRINUSE and the allocator must fall through to the next
  // candidate rather than giving up.
  it('skips a port squatted by another process (EADDRINUSE) and keeps going', async () => {
    const squatter = net.createServer();
    const mid = MIN + 5;
    await new Promise<void>((r) => squatter.listen(mid, '127.0.0.1', r));
    try {
      const handles = [];
      for (let i = 0; i < MAX - MIN; i++) handles.push(await openDccListener({ timeoutMs: 1000 }));
      expect(handles.map((h) => h.port).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i).filter((p) => p !== mid),
      );
      for (const h of handles) h.close();
      await Promise.all(handles.map((h) => expect(h.accepted).rejects.toThrow(/closed/)));
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it('rejects when no port range is configured', async () => {
    delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
    await expect(openDccListener()).rejects.toThrow(/not configured/);
  });

  it('drops a connection from an unexpected peer and keeps waiting', async () => {
    // Loopback connections all report 127.0.0.1; expecting a different host
    // means the localhost dial is dropped and the offer times out.
    const handle = await openDccListener({ timeoutMs: 200, expectPeerHost: '203.0.113.5' });
    const client = await connect(handle.port);
    await expect(handle.accepted).rejects.toThrow(/timed out/);
    client.destroy();
  });

  it('accepts a connection matching expectPeerHost', async () => {
    const handle = await openDccListener({ timeoutMs: 2000, expectPeerHost: '127.0.0.1' });
    const client = await connect(handle.port);
    const server = await handle.accepted;
    expect(server).toBeInstanceOf(net.Socket);
    server.destroy();
    client.destroy();
  });
});
