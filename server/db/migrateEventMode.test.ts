// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type BetterSqlite3 from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: BetterSqlite3.Database;
let createUser: typeof import('./users.js').createUser;
let getUserSettings: typeof import('./settings.js').getUserSettings;
let migrateSmartFilterToEventMode: typeof import('./migrateEventMode.js').migrateSmartFilterToEventMode;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ getUserSettings } = await import('./settings.js'));
  ({ migrateSmartFilterToEventMode } = await import('./migrateEventMode.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a raw settings row, bypassing the registry validation the API applies. */
function setRaw(userId: number, key: string, json: string): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, key, json);
}

function rawKeys(userId: number): string[] {
  return (
    db
      .prepare(`SELECT key FROM user_settings WHERE user_id = ? ORDER BY key`)
      .all(userId) as Array<{
      key: string;
    }>
  ).map((r) => r.key);
}

describe('migrateSmartFilterToEventMode (#666)', () => {
  it('carries an enabled smart filter onto BOTH tier keys', () => {
    // The whole point of the migration. Writing only the desktop key would
    // quietly downgrade this person's phone to "show me everything" — a
    // behavior change on a device they never touched a setting for, since
    // smart filtering was one global preference before the tier split it.
    const user = createUser('sf-on');
    setRaw(user.id, 'chat.smart_filter', 'true');

    expect(migrateSmartFilterToEventMode(db)).toBe(1);

    const values = getUserSettings(user.id);
    expect(values['chat.events']).toBe('smart');
    expect(values['chat.events.mobile']).toBe('smart');
    expect(rawKeys(user.id)).not.toContain('chat.smart_filter');
  });

  it('retires an explicitly-disabled smart filter without storing a default row', () => {
    // `all` IS the registry default, and the server drops rows equal to their
    // default on ordinary writes. Persisting one here would light the Settings
    // UI's "modified" marker up on a setting the user never chose.
    const user = createUser('sf-off');
    setRaw(user.id, 'chat.smart_filter', 'false');

    expect(migrateSmartFilterToEventMode(db)).toBe(1);

    expect(getUserSettings(user.id)['chat.events']).toBeUndefined();
    expect(rawKeys(user.id)).not.toContain('chat.smart_filter');
  });

  it('never clobbers a tier the user has already set', () => {
    // A client on the new build can write a tier before this runs — a
    // mid-upgrade session, or a DB restored from a mixed backup. The explicit
    // newer choice outranks the legacy row we are here to retire.
    const user = createUser('sf-conflict');
    setRaw(user.id, 'chat.smart_filter', 'true');
    setRaw(user.id, 'chat.events', '"none"');

    migrateSmartFilterToEventMode(db);

    const values = getUserSettings(user.id);
    expect(values['chat.events']).toBe('none');
    // The key they hadn't set still gets the legacy preference.
    expect(values['chat.events.mobile']).toBe('smart');
  });

  it('treats a malformed legacy row as unset and retires it', () => {
    // getUserSettings already skips unparseable rows, so this one was doing
    // nothing. Converting it to the default and deleting it stops it being a
    // row nothing in the system can read.
    const user = createUser('sf-garbage');
    setRaw(user.id, 'chat.smart_filter', 'not json');

    expect(migrateSmartFilterToEventMode(db)).toBe(1);

    expect(getUserSettings(user.id)['chat.events']).toBeUndefined();
    expect(rawKeys(user.id)).not.toContain('chat.smart_filter');
  });

  it('is idempotent and self-terminating', () => {
    const user = createUser('sf-rerun');
    setRaw(user.id, 'chat.smart_filter', 'true');

    expect(migrateSmartFilterToEventMode(db)).toBe(1);
    // Nothing left to convert — this is what lets it run unguarded on every
    // boot instead of needing a schema_version it could be stamped past.
    expect(migrateSmartFilterToEventMode(db)).toBe(0);
    expect(getUserSettings(user.id)['chat.events']).toBe('smart');
  });

  it('leaves users who never set the legacy key alone', () => {
    const user = createUser('sf-untouched');
    setRaw(user.id, 'chat.consolidate_max_names', '9');

    migrateSmartFilterToEventMode(db);

    expect(rawKeys(user.id)).toEqual(['chat.consolidate_max_names']);
  });

  it('migrates several users in one pass', () => {
    const a = createUser('sf-multi-a');
    const b = createUser('sf-multi-b');
    setRaw(a.id, 'chat.smart_filter', 'true');
    setRaw(b.id, 'chat.smart_filter', 'true');

    expect(migrateSmartFilterToEventMode(db)).toBe(2);

    expect(getUserSettings(a.id)['chat.events']).toBe('smart');
    expect(getUserSettings(b.id)['chat.events']).toBe('smart');
  });
});
