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

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  userId = createUser('bouncer_pane').id;
  const router = (await import('./bouncer.js')).default;
  app = createTestApp({ '/api/bouncer': router });
});

afterAll(() => ctx.cleanup());

afterEach(() => {
  delete process.env.LURKER_BOUNCER_PUBLIC_URL;
  delete process.env.LURKER_BOUNCER_PORT;
  delete process.env.LURKER_BOUNCER_TLS;
});

async function read() {
  const agent = await createAuthedAgent(app, userId);
  const res = await agent.get('/api/bouncer');
  expect(res.status).toBe(200);
  return res.body as { host: string | null; port: number; tls: boolean; pinned: boolean };
}

describe('GET /api/bouncer', () => {
  it('needs a session', async () => {
    expect((await createAnonAgent(app).get('/api/bouncer')).status).toBe(401);
  });

  it("falls back to the listener's own port and TLS, with no hostname to give", async () => {
    process.env.LURKER_BOUNCER_PORT = '6668';
    expect(await read()).toEqual({ host: null, port: 6668, tls: true, pinned: false });
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
    expect(await read()).toEqual({ host: 'irc.example.com', port: 6697, tls: true, pinned: true });
  });

  it('takes a pinned plaintext address, and the listener port when none is given', async () => {
    process.env.LURKER_BOUNCER_PORT = '6668';
    process.env.LURKER_BOUNCER_PUBLIC_URL = 'irc://irc.example.com';
    expect(await read()).toEqual({ host: 'irc.example.com', port: 6668, tls: false, pinned: true });
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
