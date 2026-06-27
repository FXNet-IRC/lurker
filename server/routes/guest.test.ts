// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-guest');

process.env.LURKER_PUBLIC_MODE = 'true';
process.env.LURKER_LOCK_NETWORKS = 'true';
process.env.LURKER_FORCED_NETWORK_HOST = 'irc.fxnet.org';
process.env.LURKER_GUEST_RATELIMIT_PER_IP = '100'; // don't trip the limiter incidentally

let app: Express;
let listNetworksForUser: typeof import('../db/networks.js').listNetworksForUser;
let findUserById: typeof import('../db/users.js').findUserById;
let createGuestUser: typeof import('../db/users.js').createGuestUser;
let getPasswordHash: typeof import('../db/users.js').getPasswordHash;
let verifyPassword: typeof import('../services/password.js').verifyPassword;
let startNetworkSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  (await import('../utils/forcedNetwork.js')).resetForcedNetworkCacheForTests();
  (await import('../utils/publicMode.js')).resetPublicModeCacheForTests();

  // Don't open real IRC sockets in tests.
  const ircManager = (await import('../services/ircManager.js')).default;
  startNetworkSpy = vi.spyOn(ircManager, 'startNetwork').mockReturnValue(null);

  const guestRouter = (await import('./guest.js')).default;
  const authRouter = (await import('./auth.js')).default;
  ({ listNetworksForUser } = await import('../db/networks.js'));
  ({ findUserById, createGuestUser, getPasswordHash } = await import('../db/users.js'));
  ({ verifyPassword } = await import('../services/password.js'));

  app = createTestApp({ '/api/guest': guestRouter, '/api/auth': authRouter });
});

afterAll(() => ctx.cleanup());

describe('POST /api/guest', () => {
  it('creates a guest, seeds the network, connects and sets a session cookie', async () => {
    const res = await request(app).post('/api/guest').send({ nick: 'Nova' });
    expect(res.status).toBe(201);
    expect(res.body.nick).toBe('Nova');
    expect(res.body.user.is_guest).toBe(true);

    const user = findUserById(res.body.user.id);
    expect(user!.is_guest).toBe(1);

    const nets = listNetworksForUser(user!.id);
    expect(nets).toHaveLength(1);
    expect(nets[0].nick).toBe('Nova');

    // Connected with a client IP forwarded for WEBIRC.
    expect(startNetworkSpy).toHaveBeenCalledWith(
      user!.id,
      nets[0].id,
      expect.objectContaining({ clientIp: expect.any(String) }),
    );

    const cookie = res.headers['set-cookie']?.[0] || '';
    expect(cookie).toContain('lurker_session=');
  });

  it('falls back to a Guest##### nick when none is given', async () => {
    const res = await request(app).post('/api/guest').send({});
    expect(res.status).toBe(201);
    expect(res.body.nick).toMatch(/^Guest\d{5}$/);
  });

  it('sanitizes a hostile nick rather than reflecting it', async () => {
    const res = await request(app).post('/api/guest').send({ nick: '99 bad nick!!' });
    expect(res.status).toBe(201);
    // spaces/punctuation stripped, leading digits removed; never empty.
    expect(res.body.nick).not.toContain(' ');
    expect(res.body.nick).not.toMatch(/^\d/);
  });

  it('404s when public mode is disabled', async () => {
    const { resetPublicModeCacheForTests } = await import('../utils/publicMode.js');
    process.env.LURKER_PUBLIC_MODE = 'false';
    resetPublicModeCacheForTests();
    try {
      const res = await request(app).post('/api/guest').send({ nick: 'Nope' });
      expect(res.status).toBe(404);
    } finally {
      process.env.LURKER_PUBLIC_MODE = 'true';
      resetPublicModeCacheForTests();
    }
  });
});

describe('POST /api/auth/claim/password', () => {
  it('converts a guest into a permanent account, keeping the row', async () => {
    const guest = createGuestUser('guest-claim-1');
    const agent = await createAuthedAgent(app, guest.id);
    const res = await agent
      .post('/api/auth/claim/password')
      .send({ username: 'claimedalice', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.is_guest).toBe(false);
    expect(res.body.user.username).toBe('claimedalice');

    const after = findUserById(guest.id);
    expect(after!.id).toBe(guest.id); // same row — settings/history retained
    expect(after!.is_guest).toBe(0);
    expect(after!.username).toBe('claimedalice');
    expect(verifyPassword('password123', getPasswordHash(guest.id))).toBe(true);
  });

  it('409s when the caller is not a guest', async () => {
    const { createUser } = await import('../db/users.js');
    const real = createUser('already-real');
    const agent = await createAuthedAgent(app, real.id);
    const res = await agent
      .post('/api/auth/claim/password')
      .send({ username: 'whatever', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('409s on a taken username', async () => {
    const guest = createGuestUser('guest-claim-2');
    const agent = await createAuthedAgent(app, guest.id);
    const res = await agent
      .post('/api/auth/claim/password')
      .send({ username: 'claimedalice', password: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('first-run setup is closed in public mode', () => {
  it('setup-status reports needsSetup:false', async () => {
    const res = await request(app).get('/api/auth/setup-status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(false);
  });

  it('refuses open password setup (no public visitor can seize admin)', async () => {
    const res = await request(app)
      .post('/api/auth/setup/password')
      .send({ username: 'wannabeadmin', password: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('guest reaper', () => {
  it('reaps an idle guest but spares a fresh one', async () => {
    const db = (await import('../db/index.js')).default;
    const { reapIdleGuestsOnce } = await import('../services/guestReaper.js');

    const idle = createGuestUser('guest-idle');
    const fresh = createGuestUser('guest-fresh');
    // Backdate the idle guest well past the default 30-minute window.
    db.prepare(`UPDATE users SET last_seen_at = datetime('now', '-2 hours') WHERE id = ?`).run(
      idle.id,
    );

    reapIdleGuestsOnce();

    expect(findUserById(idle.id)).toBeUndefined();
    expect(findUserById(fresh.id)).toBeDefined();
  });
});
