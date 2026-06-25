// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { setupTestDb, createTestApp } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-provision');

const SECRET = 'provision-secret';
process.env.LURKER_PROVISION_SECRET = SECRET;
// Lock on so provisioning seeds the FXNet network + channels.
process.env.LURKER_LOCK_NETWORKS = 'true';
process.env.LURKER_FORCED_NETWORK_HOST = 'irc.fxnet.org';

let app: Express;
let listNetworksForUser: typeof import('../db/networks.js').listNetworksForUser;
let listChannels: typeof import('../db/networks.js').listChannels;
let findUserByUsername: typeof import('../db/users.js').findUserByUsername;
let getPasswordHash: typeof import('../db/users.js').getPasswordHash;
let verifyPassword: typeof import('../services/password.js').verifyPassword;

beforeAll(async () => {
  const { resetForcedNetworkCacheForTests } = await import('../utils/forcedNetwork.js');
  resetForcedNetworkCacheForTests();

  const router = (await import('./provision.js')).default;
  ({ listNetworksForUser, listChannels } = await import('../db/networks.js'));
  ({ findUserByUsername, getPasswordHash } = await import('../db/users.js'));
  ({ verifyPassword } = await import('../services/password.js'));

  app = createTestApp({ '/api/provision': router });
});

afterAll(() => ctx.cleanup());

function provision(body: Record<string, unknown>, secret: string | null = SECRET) {
  const req = request(app).post('/api/provision/users');
  if (secret !== null) req.set('Authorization', `Bearer ${secret}`);
  return req.send(body);
}

describe('provisioning auth', () => {
  it('fails closed with 503 when no secret is configured', async () => {
    const saved = process.env.LURKER_PROVISION_SECRET;
    delete process.env.LURKER_PROVISION_SECRET;
    try {
      const res = await provision({ username: 'nope', password: 'password123' }, null);
      expect(res.status).toBe(503);
    } finally {
      process.env.LURKER_PROVISION_SECRET = saved;
    }
  });

  it('401s without a bearer token', async () => {
    const res = await provision({ username: 'x', password: 'password123' }, null);
    expect(res.status).toBe(401);
  });

  it('401s with the wrong secret', async () => {
    const res = await provision({ username: 'x', password: 'password123' }, 'wrong');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/provision/users', () => {
  it('rejects an invalid username', async () => {
    const res = await provision({ username: 'bad/name', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('rejects a weak password', async () => {
    const res = await provision({ username: 'weakpass', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('creates the account, sets the password, and seeds the FXNet network', async () => {
    const res = await provision({ username: 'alice', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('alice');

    const user = findUserByUsername('alice');
    expect(user).toBeDefined();
    expect(user!.role).toBe('user');
    expect(verifyPassword('password123', getPasswordHash(user!.id))).toBe(true);

    const nets = listNetworksForUser(user!.id);
    expect(nets).toHaveLength(1);
    expect(nets[0].host).toBe('irc.fxnet.org');
    expect(nets[0].nick).toBe('alice');

    const channels = listChannels(nets[0].id).map((c) => c.name);
    expect(channels).toEqual(expect.arrayContaining(['#chat', '#help', '#fxnet']));
  });

  it('409s on a duplicate username', async () => {
    await provision({ username: 'dup', password: 'password123' });
    const res = await provision({ username: 'dup', password: 'password123' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/provision/check', () => {
  it('reports a free username as available', async () => {
    const res = await request(app)
      .get('/api/provision/check?username=freebie')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, available: true });
  });

  it('reports a taken username as unavailable', async () => {
    await provision({ username: 'taken', password: 'password123' });
    const res = await request(app)
      .get('/api/provision/check?username=taken')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.body).toEqual({ valid: true, available: false });
  });

  it('reports an invalid username as not valid', async () => {
    const res = await request(app)
      .get('/api/provision/check?username=bad%2Fname')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.body).toEqual({ valid: false, available: false });
  });
});
