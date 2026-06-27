// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('backfill-first-admin');

let db: typeof import('./index.js').default;
let backfillFirstAdmin: typeof import('./index.js').backfillFirstAdmin;
let createUser: typeof import('./users.js').createUser;
let createGuestUser: typeof import('./users.js').createGuestUser;
let findUserById: typeof import('./users.js').findUserById;
let resetPublicModeCacheForTests: typeof import('../utils/publicMode.js').resetPublicModeCacheForTests;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ backfillFirstAdmin } = await import('./index.js'));
  ({ createUser, createGuestUser, findUserById } = await import('./users.js'));
  ({ resetPublicModeCacheForTests } = await import('../utils/publicMode.js'));
});

afterEach(() => {
  db.exec('DELETE FROM users');
  delete process.env.LURKER_PUBLIC_MODE;
  resetPublicModeCacheForTests();
});

afterAll(() => ctx.cleanup());

describe('backfillFirstAdmin', () => {
  it('never promotes a guest, even when it is the only/earliest account', () => {
    delete process.env.LURKER_PUBLIC_MODE; // even with public mode off
    resetPublicModeCacheForTests();
    const guest = createGuestUser('guest-1');
    backfillFirstAdmin();
    expect(findUserById(guest.id)!.role).toBe('user');
  });

  it('demotes a guest that wrongly holds admin', () => {
    const guest = createGuestUser('guest-2');
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(guest.id);
    backfillFirstAdmin();
    expect(findUserById(guest.id)!.role).toBe('user');
  });

  it('promotes the earliest non-guest user when no admin exists (standalone)', () => {
    const guest = createGuestUser('guest-3'); // earliest, but a guest
    const real = createUser('real-1'); // first real account
    backfillFirstAdmin();
    expect(findUserById(guest.id)!.role).toBe('user');
    expect(findUserById(real.id)!.role).toBe('admin');
  });

  it('never auto-promotes anyone in public mode', () => {
    process.env.LURKER_PUBLIC_MODE = 'true';
    resetPublicModeCacheForTests();
    const real = createUser('real-2'); // a real account, but public mode is on
    backfillFirstAdmin();
    // No admin handed out automatically — must be provisioned explicitly.
    expect(findUserById(real.id)!.role).toBe('user');
  });
});
