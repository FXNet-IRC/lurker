// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// Network-lock behavior of the networks routes. Kept in its own file because the
// forced-network config is cached per process and vitest isolates files — so the
// lock is "on" here without disturbing networks.test.ts, which exercises the
// unlocked (upstream) paths.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-networks-lock');

// Lock on, bound to a host — must be set before the first isNetworkLockEnabled()
// call the route makes.
process.env.LURKER_LOCK_NETWORKS = 'true';
process.env.LURKER_FORCED_NETWORK_HOST = 'irc.fxnet.org';

const fakeManager = {
  calls: Array<unknown[]>(),
  disposeNetwork() {
    this.calls.push(['disposeNetwork']);
  },
  startNetwork() {
    this.calls.push(['startNetwork']);
  },
  listContacts() {
    return [];
  },
};
vi.mock('../services/ircManager.js', () => ({ default: fakeManager }));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let seededId: number;

beforeAll(async () => {
  const { resetForcedNetworkCacheForTests } = await import('../utils/forcedNetwork.js');
  resetForcedNetworkCacheForTests();

  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const router = (await import('./networks.js')).default;

  user = createUser('lock-user');
  // Seed the one network directly (the API can't create it while locked).
  const net = createNetwork(user.id, {
    name: 'FXNet',
    host: 'irc.fxnet.org',
    port: 6697,
    tls: true,
    nick: 'lock-user',
  });
  seededId = net!.id;

  app = createTestApp({ '/api/networks': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

describe('network lock', () => {
  it('refuses to create additional networks (403)', async () => {
    const res = await agent.post('/api/networks').send({
      name: 'libera',
      host: 'irc.libera.chat',
      nick: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('refuses to delete the locked network (403)', async () => {
    const res = await agent.delete(`/api/networks/${seededId}`);
    expect(res.status).toBe(403);
    expect(fakeManager.calls.some(([m]) => m === 'disposeNetwork')).toBe(false);
  });

  it('strips destination and ident edits but applies identity edits', async () => {
    const res = await agent.patch(`/api/networks/${seededId}`).send({
      host: 'evil.example.com',
      port: 1234,
      tls: false,
      username: 'spoofed-ident',
      nick: 'newnick',
    });
    expect(res.status).toBe(200);
    // Destination + ident source are untouched; only the nick changed.
    expect(res.body.network.host).toBe('irc.fxnet.org');
    expect(res.body.network.port).toBe(6697);
    expect(res.body.network.tls).toBe(true);
    expect(res.body.network.username).not.toBe('spoofed-ident');
    expect(res.body.network.nick).toBe('newnick');
  });
});
