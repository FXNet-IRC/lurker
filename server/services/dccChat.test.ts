// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import net from 'net';
import { DccChat } from './dccChat.js';

// A connected socket pair over loopback.
function socketPair(): Promise<{ a: net.Socket; b: net.Socket; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((a) => {
      a.on('error', () => {});
      resolve({ a, b, server });
    });
    let b!: net.Socket;
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      b = net.connect({ host: '127.0.0.1', port });
      b.on('error', () => {});
    });
  });
}

// Resolve once `lines` has reached `n` entries. A fixed sleep here is the
// classic Mac-passes / Linux-fails flake: it encodes a guess about scheduling
// rather than the condition the assertion actually depends on.
function untilLines(lines: string[], n: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (lines.length >= n) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`only ${lines.length} of ${n} lines after ${timeoutMs}ms`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('DccChat', () => {
  it('frames outbound text with CRLF and splits inbound lines', async () => {
    const { a, b } = await socketPair();
    const linesA: string[] = [];
    const chat = new DccChat({ socket: a, onLine: (t) => linesA.push(t) });
    chat.start();

    // b (the peer) sends two lines in one packet, split across a boundary.
    b.write('hello ');
    b.write('world\r\nsecond line\r\n');

    await untilLines(linesA, 2);
    expect(linesA).toEqual(['hello world', 'second line']);

    // a sends back; b receives with CRLF framing.
    const gotB = new Promise<string>((r) => b.once('data', (d) => r(d.toString())));
    expect(chat.send('reply here')).toBe(true);
    expect(await gotB).toBe('reply here\r\n');

    chat.close();
  });

  it('strips embedded CR/LF from a sent line so it cannot inject extra lines', async () => {
    const { a, b } = await socketPair();
    const chat = new DccChat({ socket: a });
    chat.start();
    const gotB = new Promise<string>((r) => b.once('data', (d) => r(d.toString())));
    chat.send('line1\r\nINJECTED');
    expect(await gotB).toBe('line1  INJECTED\r\n');
    chat.close();
  });

  it('fires onClose when the peer disconnects', async () => {
    const { a, b } = await socketPair();
    const closed = new Promise<void>((r) => {
      const chat = new DccChat({ socket: a, onClose: () => r() });
      chat.start();
    });
    b.end();
    await expect(closed).resolves.toBeUndefined();
  });

  it('send() returns false after close', async () => {
    const { a } = await socketPair();
    const chat = new DccChat({ socket: a });
    chat.start();
    chat.close();
    expect(chat.send('nope')).toBe(false);
  });

  // irssi force-splits an over-long unterminated line rather than dropping the
  // session or silently truncating; the heap stays bounded either way.
  it('force-splits a peer that streams past the cap with no newline', async () => {
    const { a, b } = await socketPair();
    const lines: string[] = [];
    let errored: Error | null = null;
    const chat = new DccChat({
      socket: a,
      onLine: (t) => lines.push(t),
      onError: (e) => {
        errored = e;
      },
    });
    chat.start();

    // 80 KB with no newline, against a 64 KB cap: one forced split, and the
    // 16 KB remainder stays buffered until a terminator (or close) arrives.
    b.write('x'.repeat(80 * 1024));
    await untilLines(lines, 1);
    expect(lines[0]).toHaveLength(64 * 1024);
    expect(errored).toBeNull();

    // The session is still usable — a terminator flushes the remainder.
    b.write('\n');
    await untilLines(lines, 2);
    expect(lines[1]).toHaveLength(16 * 1024);

    chat.close();
  });

  it('accepts bare LF as a line terminator, not just CRLF', async () => {
    const { a, b } = await socketPair();
    const lines: string[] = [];
    const chat = new DccChat({ socket: a, onLine: (t) => lines.push(t) });
    chat.start();
    // irssi, HexChat and repartee all send bare LF.
    b.write('from irssi\nfrom weechat\r\n');
    await untilLines(lines, 2);
    expect(lines).toEqual(['from irssi', 'from weechat']);
    chat.close();
  });

  it('dials host:port when no socket is provided and reports onConnect', async () => {
    const server = net.createServer((peer) => {
      peer.write('welcome\r\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;

    const line = new Promise<string>((res) => {
      const chat = new DccChat({
        host: '127.0.0.1',
        port,
        onLine: (t) => res(t),
      });
      chat.start();
    });
    expect(await line).toBe('welcome');
    server.close();
  });
});
