// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-settings');

let app: Express;
let agent: LurkerTestAgent;
let user: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./settings.js')).default;

  user = createUser('settings-alice');
  app = createTestApp({ '/api/settings': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/settings/bootstrap', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await createAnonAgent(app).get('/api/settings/bootstrap');
    expect(res.status).toBe(401);
  });

  it("returns the registry + the user's current values + saved themes", async () => {
    const res = await agent.get('/api/settings/bootstrap');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registry)).toBe(true);
    expect(res.body.registry.length).toBeGreaterThan(0);
    expect(typeof res.body.values).toBe('object');
    expect(Array.isArray(res.body.themes)).toBe(true);
  });
});

describe('PATCH /api/settings', () => {
  it('rejects a non-object body with 400', async () => {
    const res = await agent.patch('/api/settings').send({ changes: 'not an object' });
    expect(res.status).toBe(400);
  });

  it('persists a valid change and returns the merged values', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'look.font.size': 18 },
    });
    expect(res.status).toBe(200);
    expect(res.body.values['look.font.size']).toBe(18);
  });

  it('rejects an out-of-range int and reports the offending key', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'look.font.size': 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.key).toBe('look.font.size');
    expect(res.body.error).toMatch(/>= 9/);
  });

  it('rejects unknown keys', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'does.not.exist': true },
    });
    expect(res.status).toBe(400);
    expect(res.body.key).toBe('does.not.exist');
  });

  it('writing the default value drops the override (non-themed key)', async () => {
    await agent
      .patch('/api/settings')
      .send({ changes: { 'look.message.collapse_authors_window': 10 } });
    const before = await agent.get('/api/settings/bootstrap');
    expect(before.body.values['look.message.collapse_authors_window']).toBe(10);
    // Default is 5 per the registry.
    await agent
      .patch('/api/settings')
      .send({ changes: { 'look.message.collapse_authors_window': 5 } });
    const after = await agent.get('/api/settings/bootstrap');
    expect(after.body.values['look.message.collapse_authors_window']).toBeUndefined();
  });

  it('KEEPS a themed key written at its registry default (an override of the active theme)', async () => {
    // look.font.size is themed; under a non-default theme, "the default value"
    // is a statement, so the row must survive. Explicit reset still removes it.
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 14 } });
    const res = await agent.get('/api/settings/bootstrap');
    expect(res.body.values['look.font.size']).toBe(14);
    await agent.delete('/api/settings/look.font.size');
  });

  it('applies resets alongside changes in one call', async () => {
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 18 } });
    const res = await agent.patch('/api/settings').send({
      changes: { 'look.theme.active': 'light' },
      resets: ['look.font.size'],
    });
    expect(res.status).toBe(200);
    expect(res.body.values['look.font.size']).toBeUndefined();
    expect(res.body.values['look.theme.active']).toBe('light');
    await agent.delete('/api/settings/look.theme.active');
  });

  it('rejects a body with neither changes nor resets', async () => {
    const res = await agent.patch('/api/settings').send({});
    expect(res.status).toBe(400);
  });

  it('rejects non-array resets and unknown reset keys', async () => {
    const bad = await agent.patch('/api/settings').send({ resets: 'look.font.size' });
    expect(bad.status).toBe(400);
    const unknown = await agent.patch('/api/settings').send({ resets: ['no.such.key'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.key).toBe('no.such.key');
  });
});

describe('DELETE /api/settings/:key', () => {
  it('rejects unknown keys with 400', async () => {
    const res = await agent.delete('/api/settings/no.such.key');
    expect(res.status).toBe(400);
  });

  it('resets a known key', async () => {
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 22 } });
    const res = await agent.delete('/api/settings/look.font.size');
    expect(res.status).toBe(200);
    expect(res.body.values['look.font.size']).toBeUndefined();
  });
});
