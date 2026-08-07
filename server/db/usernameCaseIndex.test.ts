// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A DB that ALREADY contains two accounts differing only by case must still
// boot. The case-insensitive unique index can't be created against such a
// table, and an unguarded CREATE at module load would throw during import —
// taking the whole server down in a restart loop over two legacy rows nobody
// has complained about. This pins the guard: the index is skipped with a
// warning, the rows survive untouched, and both accounts stay reachable.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-username-case-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// Seed the case-twin pair BEFORE importing ./index.js — the only way they could
// exist is having been created back when the schema allowed them.
{
  const seed = new Database(process.env.DATABASE_PATH);
  seed.exec(
    `CREATE TABLE users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const insert = seed.prepare('INSERT INTO users (username) VALUES (?)');
  insert.run('Twin');
  insert.run('twin');
  insert.run('legacy name');
  seed.close();
}

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

let db: typeof import('./index.js').default;
let users: typeof import('./users.js');

beforeAll(async () => {
  // Must not throw. That IS the assertion — an import-time throw here is a
  // crash-looping server in production.
  db = (await import('./index.js')).default;
  users = await import('./users.js');
});

afterAll(() => {
  warn.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a legacy DB with case-twin usernames', () => {
  it('boots instead of crash-looping, and says why in a warning', () => {
    const messages = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/case-insensitive username index not created/);
  });

  it('skips the index rather than dropping a row', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .get('idx_users_username_nocase');
    expect(idx).toBeUndefined();
    expect(users.listUsers().map((u) => u.username)).toEqual(
      expect.arrayContaining(['Twin', 'twin', 'legacy name']),
    );
  });

  it('resolves each twin to ITSELF — never to an arbitrary one of the pair', () => {
    // The exact-match-first rule. Folding case blindly here could authenticate
    // the wrong person, which is the one outcome worse than a legacy duplicate.
    expect(users.findUserByUsername('Twin')!.username).toBe('Twin');
    expect(users.findUserByUsername('twin')!.username).toBe('twin');
  });

  it('refuses to guess when the typed case matches NEITHER twin', () => {
    expect(users.findUserByUsername('TWIN')).toBeUndefined();
  });

  it('still reports the pair as taken, so a third twin cannot be created', () => {
    expect(users.usernameTaken('TWIN')).toBe(true);
  });

  it('lists both twins and the spaced name as grandfathered', () => {
    const flagged = users.listGrandfatheredUsernames();
    const by = (name: string) => flagged.find((f) => f.username === name)?.why;
    expect(by('Twin')).toMatch(/case/);
    expect(by('twin')).toMatch(/case/);
    expect(by('legacy name')).toMatch(/space/);
  });
});
