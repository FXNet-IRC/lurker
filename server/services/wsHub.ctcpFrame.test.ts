// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `ctcp` frame (/ctcp, /ping), through a real socket, aimed at a `=nick`
// DCC chat (#270).
//
// A CTCP rides the IRC wire, and `=bob` is a buffer name rather than a nick, so
// ircManager refuses it — dccChatWiring.test.ts pins that chokepoint. What this
// pins is what the user is TOLD: ircManager's refusal is a bare false, and
// wsHub's existing reading of false is "this network isn't connected", which is
// both wrong here and no help.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-ctcpframe');

let server: http.Server;
let userId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('ctcpframeuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'ctcpframeuser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, 'ctcpframe-test-secret');
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

// Connect, drain the opening burst, then send one frame and return the first
// `ctcp` status line that comes back.
async function ctcpReply(frame: Frame): Promise<Frame> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  try {
    return await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ctcp status line')), 3000);
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as Frame;
        if (f.kind === 'backlog-complete') ws.send(JSON.stringify(frame));
        if (f.kind === 'irc' && f.type === 'ctcp') {
          clearTimeout(timer);
          resolve(f);
        }
      });
    });
  } finally {
    ws.close();
  }
}

const ctcp = (target: string, ctcpType: string, args = '') => ({
  type: 'ctcp',
  networkId,
  target,
  issuingTarget: '=bob',
  ctcpType,
  args,
});

describe('a ctcp frame aimed at a DCC chat', () => {
  // ⚠ The line names no command: `/ping =bob` and `/ctcp =bob PING` send this
  // same frame, so a `/ping:` prefix would misname the second. The suggestion
  // follows the CTCP type, which is right for either.
  it('says the buffer is a DCC chat and names the nick to use, for a PING', async () => {
    const reply = await ctcpReply(ctcp('=bob', 'PING'));
    expect(reply.text).toBe(
      '=bob is a DCC chat, not a nick. CTCP goes over IRC, so use /ping bob.',
    );
    expect(reply.target).toBe('=bob');
    expect(reply.level).toBe('warn');
  });

  it('and for any other type, keeping it', async () => {
    const reply = await ctcpReply(ctcp('=bob', 'VERSION'));
    expect(reply.text).toBe(
      '=bob is a DCC chat, not a nick. CTCP goes over IRC, so use /ctcp bob VERSION.',
    );
  });

  // ⚠ The suggestion is the same request aimed at the nick. `/ping` sends a
  // fresh timestamp, so it isn't that for a PING carrying its own argument.
  it('carries arguments over, and offers /ping only for a bare PING', async () => {
    expect((await ctcpReply(ctcp('=bob', 'PING', '12345'))).text).toBe(
      '=bob is a DCC chat, not a nick. CTCP goes over IRC, so use /ctcp bob PING 12345.',
    );
    expect((await ctcpReply(ctcp('=bob', 'VERSION', 'extra words'))).text).toBe(
      '=bob is a DCC chat, not a nick. CTCP goes over IRC, so use /ctcp bob VERSION extra words.',
    );
  });

  it('suggests nothing for a bare =, which has no peer', async () => {
    const reply = await ctcpReply(ctcp('=', 'PING'));
    expect(reply.text).toBe('= is a DCC chat, not a nick.');
  });

  // `==bob` peels to `=bob`, and suggesting `/ping =bob` would name a target
  // this same check refuses.
  it('suggests nothing when the peer is not a nick either', async () => {
    const reply = await ctcpReply(ctcp('==bob', 'PING'));
    expect(reply.text).toBe('==bob is a DCC chat, not a nick.');
  });

  // The check sits ahead of the old one without taking its place.
  it('still reports a nick on a network with no connection as not connected', async () => {
    const reply = await ctcpReply(ctcp('bob', 'PING'));
    expect(reply.text).toBe('/ping: this network isn’t connected');
  });
});
