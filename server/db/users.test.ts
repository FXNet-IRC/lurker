// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-users-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let users: typeof import('./users.js');

beforeAll(async () => {
  users = await import('./users.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('createUser / findUser', () => {
  it('creates a user with default role=user', async () => {
    const u = users.createUser('plain-user');
    expect(u.username).toBe('plain-user');
    expect(u.role).toBe('user');
    expect(users.findUserById(u.id)).toMatchObject({ username: 'plain-user', role: 'user' });
    expect(users.findUserByUsername('plain-user')!.id).toBe(u.id);
  });

  it('creates a user with role=admin when requested', () => {
    const u = users.createUser('admin-user', { role: 'admin' });
    expect(u.role).toBe('admin');
  });

  it('username uniqueness is enforced by the schema', () => {
    users.createUser('dupe-target');
    expect(() => users.createUser('dupe-target')).toThrow(/UNIQUE constraint failed/);
  });

  it('uniqueness is CASE-INSENSITIVE at the schema level too', () => {
    // The DB index is the backstop for any path that forgets to call
    // usernameTaken — 'Casey' and 'casey' must not be two accounts.
    users.createUser('casey');
    expect(() => users.createUser('CASEY')).toThrow(/UNIQUE constraint failed/);
  });
});

describe('findUserByUsername is case-insensitive', () => {
  it('finds an account regardless of the case typed', () => {
    const u = users.createUser('MixedCase');
    expect(users.findUserByUsername('mixedcase')!.id).toBe(u.id);
    expect(users.findUserByUsername('MIXEDCASE')!.id).toBe(u.id);
    expect(users.findUserByUsername('MixedCase')!.id).toBe(u.id);
  });

  it('returns undefined for a genuinely unknown name', () => {
    expect(users.findUserByUsername('nobody-here')).toBeUndefined();
  });
});

describe('usernameTaken', () => {
  it('answers case-insensitively so signup cannot mint a case-twin', () => {
    users.createUser('Claimed');
    expect(users.usernameTaken('claimed')).toBe(true);
    expect(users.usernameTaken('CLAIMED')).toBe(true);
    expect(users.usernameTaken('unclaimed')).toBe(false);
  });
});

describe('listGrandfatheredUsernames', () => {
  it('names a legacy username with a space', async () => {
    // Inserted straight past the route validation, which is exactly how such a
    // row got there: it was legal when it was created.
    const db = (await import('./index.js')).default;
    db.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run('legacy name', 'user');
    const flagged = users.listGrandfatheredUsernames();
    expect(flagged.find((f) => f.username === 'legacy name')?.why).toMatch(/space/);
  });

  it('says nothing about accounts that already conform', () => {
    const flagged = users.listGrandfatheredUsernames();
    expect(flagged.find((f) => f.username === 'plain-user')).toBeUndefined();
  });
});

describe('countUsers / countAdmins', () => {
  it('reflects the current population', () => {
    const before = users.countUsers();
    const beforeAdmins = users.countAdmins();
    users.createUser('count-1');
    users.createUser('count-admin', { role: 'admin' });
    expect(users.countUsers()).toBe(before + 2);
    expect(users.countAdmins()).toBe(beforeAdmins + 1);
  });
});

describe('password hashes', () => {
  it('userHasPassword reflects setPasswordHash', () => {
    const u = users.createUser('pwd-test');
    expect(users.userHasPassword(u.id)).toBe(false);
    users.setPasswordHash(u.id, 'scrypt$32768$8$1$xxx$yyy');
    expect(users.userHasPassword(u.id)).toBe(true);
    expect(users.getPasswordHash(u.id)).toMatch(/^scrypt\$/);
    users.setPasswordHash(u.id, null);
    expect(users.userHasPassword(u.id)).toBe(false);
  });
});

describe('listUsers', () => {
  it('orders by id ascending', () => {
    const list = users.listUsers();
    const ids = list.map((u) => u.id);
    const sorted = ids.toSorted((a, b) => a - b);
    expect(ids).toEqual(sorted);
  });
});

describe('deleteUser', () => {
  it('returns true for a real id, false for a phantom', () => {
    const u = users.createUser('delete-me');
    expect(users.deleteUser(u.id)).toBe(true);
    expect(users.findUserById(u.id)).toBeUndefined();
    expect(users.deleteUser(99999)).toBe(false);
  });
});

describe('touchUserLastSeen', () => {
  it('is idempotent within the 60-second throttle window', () => {
    const u = users.createUser('touch-test');
    users.touchUserLastSeen(u.id);
    const firstTouch = users.findUserById(u.id)!.last_seen_at;
    expect(firstTouch).toBeTruthy();
    users.touchUserLastSeen(u.id);
    expect(users.findUserById(u.id)!.last_seen_at).toBe(firstTouch);
  });
});
