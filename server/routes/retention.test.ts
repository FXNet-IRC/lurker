// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration tests for the read-only retention surface: the ceilings the
// Settings pane renders and the per-buffer picture /retention prints. Driven
// through the real router against a real temp DB (testApp harness).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('retention-routes');
afterAll(() => ctx.cleanup());

let app: Express;
let agent: Awaited<ReturnType<typeof createAuthedAgent>>;
let userId: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const retentionRouter = (await import('./retention.js')).default;

  const user = createUser('ret-routes');
  userId = user.id;
  const net = createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'n' });
  networkId = net!.id;
  // 30 lines spread over exactly 3 days → recent pace ≈ 10/day.
  const base = Date.parse('2026-08-24T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    insertMessage({
      networkId,
      target: '#chan',
      time: new Date(base + i * ((3 * 24 * 3_600_000) / 29)).toISOString(),
      type: 'message',
      nick: 'x',
      text: `line ${i}`,
      self: false,
    });
  }
  app = createTestApp({ '/api/retention': retentionRouter });
  agent = await createAuthedAgent(app, userId);
});

afterEach(async () => {
  delete process.env.LURKER_MAX_RETENTION_LINES;
  delete process.env.LURKER_MAX_EVENT_RETENTION_HOURS;
  const { deleteUserSetting } = await import('../db/settings.js');
  deleteUserSetting(userId, 'data.retention.lines');
});

describe('GET /api/retention/limits', () => {
  it('reports null ceilings when the operator declared none', async () => {
    const res = await agent.get('/api/retention/limits');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxLines: null, maxEventHours: null, maxClosedBufferDays: null });
  });

  it('reports the declared ceilings', async () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    process.env.LURKER_MAX_EVENT_RETENTION_HOURS = '336';
    const res = await agent.get('/api/retention/limits');
    expect(res.body).toEqual({ maxLines: 10000, maxEventHours: 336, maxClosedBufferDays: null });
  });
});

describe('GET /api/retention/buffer', () => {
  it('400s without addressing and 404s an unknown target', async () => {
    expect((await agent.get('/api/retention/buffer')).status).toBe(400);
    expect(
      (await agent.get(`/api/retention/buffer?networkId=${networkId}&target=%23nope`)).status,
    ).toBe(404);
  });

  it('resolves inherit, override, ceiling, and pace through the enforcement code', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    const { setBufferRetention } = await import('../db/bufferRetention.js');

    // Inherited global.
    setUserSetting(userId, 'data.retention.lines', 2000);
    let res = await agent.get(`/api/retention/buffer?networkId=${networkId}&target=%23chan`);
    expect(res.status).toBe(200);
    expect(res.body.overrideLines).toBeNull();
    expect(res.body.effectiveLines).toBe(2000);
    expect(res.body.effectiveEventHours).toBe(168); // registry default
    // 30 lines over 3 days.
    expect(res.body.recentLinesPerDay).toBeGreaterThanOrEqual(9);
    expect(res.body.recentLinesPerDay).toBeLessThanOrEqual(11);

    // Override wins — and the ceiling clamps what is REPORTED, because this
    // endpoint resolves through effectiveRetentionLines, not around it.
    setBufferRetention(userId, networkId, '#chan', 50000);
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    res = await agent.get(`/api/retention/buffer?networkId=${networkId}&target=%23chan`);
    expect(res.body.overrideLines).toBe(50000);
    expect(res.body.effectiveLines).toBe(10000);
  });
});
