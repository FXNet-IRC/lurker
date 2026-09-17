// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What Settings' Bouncer pane reads: where to point an IRC client. The address
// the operator pins (LURKER_BOUNCER_PUBLIC_URL) wins over the listener's own
// port and TLS, because the bouncer can be reached through something else —
// TLS terminated in front of it, or a hostname of its own.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-bouncer');

let app: Express;
let userId: number;
// What the listener publishes as it comes up (startBouncer). It isn't running
// under test, so the tests set it themselves.
let setBouncerTlsState: typeof import('../utils/bouncerConfig.js').setBouncerTlsState;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  userId = createUser('bouncer_pane').id;
  ({ setBouncerTlsState } = await import('../utils/bouncerConfig.js'));
  const router = (await import('./bouncer.js')).default;
  app = createTestApp({ '/api/bouncer': router });
});

afterAll(() => ctx.cleanup());

afterEach(() => {
  setBouncerTlsState(null);
  delete process.env.LURKER_BOUNCER_PUBLIC_URL;
  delete process.env.LURKER_BOUNCER_PORT;
  delete process.env.LURKER_BOUNCER_TLS;
});

async function read() {
  const agent = await createAuthedAgent(app, userId);
  const res = await agent.get('/api/bouncer');
  expect(res.status).toBe(200);
  return res.body as {
    host: string | null;
    port: number;
    tls: boolean;
    pinned: boolean;
    certificate: { selfSigned: boolean; fingerprint: string } | null;
  };
}

describe('GET /api/bouncer', () => {
  it('needs a session', async () => {
    expect((await createAnonAgent(app).get('/api/bouncer')).status).toBe(401);
  });

  it("falls back to the listener's own port and TLS, with no hostname to give", async () => {
    process.env.LURKER_BOUNCER_PORT = '6668';
    expect(await read()).toEqual({
      host: null,
      port: 6668,
      tls: true,
      pinned: false,
      certificate: null,
    });
  });

  it('reports TLS off when Lurker does not terminate it', async () => {
    process.env.LURKER_BOUNCER_TLS = 'off';
    expect(await read()).toMatchObject({ tls: false, pinned: false });
  });

  it('prefers the address the operator pinned, TLS and all', async () => {
    // TLS terminated in front: Lurker's own listener is plaintext, and what a
    // client should do is still connect with TLS.
    process.env.LURKER_BOUNCER_TLS = 'off';
    process.env.LURKER_BOUNCER_PUBLIC_URL = 'ircs://irc.example.com:6697';
    expect(await read()).toEqual({
      host: 'irc.example.com',
      port: 6697,
      tls: true,
      pinned: true,
      certificate: null,
    });
  });

  it('takes a pinned plaintext address, and the listener port when none is given', async () => {
    process.env.LURKER_BOUNCER_PORT = '6668';
    process.env.LURKER_BOUNCER_PUBLIC_URL = 'irc://irc.example.com';
    expect(await read()).toEqual({
      host: 'irc.example.com',
      port: 6668,
      tls: false,
      pinned: true,
      certificate: null,
    });
  });

  // url.hostname keeps the brackets; an IRC client's server field wants the
  // address itself.
  it('hands over an IPv6 address without the URL brackets', async () => {
    process.env.LURKER_BOUNCER_PUBLIC_URL = 'ircs://[2001:db8::1]:6697';
    expect(await read()).toMatchObject({ host: '2001:db8::1', port: 6697 });
  });

  // A client refuses a certificate Lurker made for itself until the member
  // accepts it, so the pane has to be able to say so.
  it("describes the certificate the listener serves, when it's Lurker's own", async () => {
    setBouncerTlsState({ selfSigned: true, fingerprint: 'AA:BB:CC' });
    expect(await read()).toMatchObject({
      certificate: { selfSigned: true, fingerprint: 'AA:BB:CC' },
    });
  });

  it('says nothing about a certificate for an address it does not answer on', async () => {
    setBouncerTlsState({ selfSigned: true, fingerprint: 'AA:BB:CC' });
    process.env.LURKER_BOUNCER_PUBLIC_URL = 'ircs://irc.example.com:6697';
    expect(await read()).toMatchObject({ certificate: null });
  });

  it('ignores an address it cannot use', async () => {
    const used: string[] = [];
    for (const bad of [
      'irc.example.com:6697', // no scheme
      'https://irc.example.com', // not IRC
      'ircs://irc.example.com/lurker', // a path is not part of an address
      'ircs://', // no host
    ]) {
      process.env.LURKER_BOUNCER_PUBLIC_URL = bad;
      if ((await read()).host !== null) used.push(bad);
    }
    expect(used).toEqual([]);
  });
});
