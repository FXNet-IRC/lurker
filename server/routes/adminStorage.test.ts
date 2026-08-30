// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration test for the admin storage stats: real router (inheriting the
// admin gate from routes/admin.ts), real temp DB, real per-network counts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('admin-storage');
afterAll(() => ctx.cleanup());

let app: Express;
let adminAgent: Awaited<ReturnType<typeof createAuthedAgent>>;
let userAgent: Awaited<ReturnType<typeof createAuthedAgent>>;
let aliceId: number;

// The ceilings assertions read live env; a deploy-adjacent shell exporting
// the operator knobs must not fail a correct test — and other files in the
// same worker share this process env, so the pre-existing values go back.
const SAVED_ENV = {
  LURKER_MAX_RETENTION_LINES: process.env.LURKER_MAX_RETENTION_LINES,
  LURKER_MAX_EVENT_RETENTION_HOURS: process.env.LURKER_MAX_EVENT_RETENTION_HOURS,
};
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeAll(async () => {
  delete process.env.LURKER_MAX_RETENTION_LINES;
  delete process.env.LURKER_MAX_EVENT_RETENTION_HOURS;
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const adminRouter = (await import('./admin.js')).default;

  const admin = createUser('storage-admin', { role: 'admin' });
  const alice = createUser('storage-alice');
  aliceId = alice.id;
  const net = createNetwork(alice.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'a' });
  for (let i = 0; i < 20; i++) {
    insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'a',
      text: `line ${i}`,
      self: false,
    });
  }
  app = createTestApp({ '/api/admin': adminRouter });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, alice.id);
});

describe('GET /api/admin/storage', () => {
  it('is admin-gated', async () => {
    expect((await userAgent.get('/api/admin/storage')).status).toBe(403);
  });

  it('reports per-user rows, file sizes, and the (unset) ceilings', async () => {
    const res = await adminAgent.get('/api/admin/storage');
    expect(res.status).toBe(200);
    expect(res.body.database.fileBytes).toBeGreaterThan(0);
    expect(res.body.ceilings).toEqual({
      maxLines: null,
      maxLinesState: 'none',
      maxEventHours: null,
      maxEventHoursState: 'none',
      maxClosedBufferDays: null,
      maxClosedBufferDaysState: 'none',
    });
    // Too few rows for a meaningful per-instance ratio → no ≈ estimates.
    expect(res.body.approxBytesPerRow).toBeNull();
    const alice = res.body.users.find((u: { id: number }) => u.id === aliceId);
    expect(alice.messageRows).toBe(20);
    // #chan plus the account's system buffer.
    expect(alice.buffers).toBeGreaterThanOrEqual(1);
    // Sorted heaviest-first: alice (20 rows) outranks the empty admin.
    expect(res.body.users[0].id).toBe(aliceId);
  });

  it('distinguishes an unparseable ceiling from an unset one, on ?refresh=1', async () => {
    process.env.LURKER_MAX_RETENTION_LINES = '100,000';
    try {
      const res = await adminAgent.get('/api/admin/storage?refresh=1');
      expect(res.body.ceilings.maxLines).toBeNull();
      expect(res.body.ceilings.maxLinesState).toBe('invalid');
    } finally {
      delete process.env.LURKER_MAX_RETENTION_LINES;
    }
  });
});
