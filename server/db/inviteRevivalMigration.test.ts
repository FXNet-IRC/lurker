// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-20 cutover (#590): invite_tokens
// carried `used_by_user_id ... ON DELETE SET NULL`, so deleting a user handed
// their spent invite back to whoever still had the link.
//
// The fixture is built by letting db/index.ts create the real schema, then
// putting ONLY invite_tokens back into its pre-v20 shape and winding
// schema_version back to 19 — rather than hand-writing a v19 DB, which can't be
// done from the base DDL alone (several tables reach their current shape through
// version-gated rebuilds, so pinning an old version skips the very migrations
// that made them current). Re-importing with a reset module registry then runs
// migrate() again against that downgraded table.
//
// Two things have to be true afterwards, and the second is the one a
// constraint-only fix would miss: new deletions cascade, AND the invites the old
// constraint already resurrected are closed rather than carried forward as
// live-looking links.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-invmig-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;
let invites: typeof import('./invites.js');

interface FkRow {
  from: string;
  on_delete: string;
}

beforeAll(async () => {
  // Phase 1 — real, fully-migrated schema.
  const fresh = (await import('./index.js')).default;
  fresh.close();

  // Phase 2 — downgrade invite_tokens to the pre-v20 constraint and seed the
  // three row shapes that matter.
  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    DROP TABLE invite_tokens;
    CREATE TABLE invite_tokens (
      token TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL,
      expires_at TEXT,
      used_by_user_id INTEGER,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_unused
      ON invite_tokens(token) WHERE used_by_user_id IS NULL;
    INSERT INTO users (id, username) VALUES (1, 'admin'), (2, 'joined');
    UPDATE app_meta SET value = '19' WHERE key = 'schema_version';

    -- still redeemable: must survive untouched
    INSERT INTO invite_tokens (token, created_by, expires_at)
      VALUES ('tok-pending', 1, NULL);
    -- properly consumed by a user who still exists
    INSERT INTO invite_tokens (token, created_by, used_by_user_id, used_at)
      VALUES ('tok-consumed', 1, 2, '2026-01-01T00:00:00.000Z');
    -- ALREADY RESURRECTED: consumed, then its redeemer was deleted and SET NULL
    -- wiped the only column anyone was reading
    INSERT INTO invite_tokens (token, created_by, used_by_user_id, used_at)
      VALUES ('tok-revived', 1, NULL, '2026-01-02T00:00:00.000Z');
  `);
  raw.close();

  // Phase 3 — boot again; this is the run under test.
  vi.resetModules();
  ({ default: db } = await import('./index.js'));
  invites = await import('./invites.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('invite_tokens v20 migration (#590)', () => {
  it('rewrites the redeemer foreign key to CASCADE', () => {
    const fk = (db.prepare(`PRAGMA foreign_key_list(invite_tokens)`).all() as FkRow[]).find(
      (f) => f.from === 'used_by_user_id',
    );
    expect(fk?.on_delete).toBe('CASCADE');
  });

  it('closes an invite the old constraint already resurrected', () => {
    // The whole point: before this migration `tok-revived` read as a live link
    // that a stranger holding the URL could still redeem.
    expect(invites.inviteStatus('tok-revived').status).toBe('unknown');
    expect(invites.consumeInvite('tok-revived', 2)).toBe(false);
  });

  it('leaves a genuinely pending invite redeemable', () => {
    expect(invites.inviteStatus('tok-pending').status).toBe('valid');
  });

  it('keeps a consumed invite whose redeemer still exists', () => {
    expect(invites.inviteStatus('tok-consumed').status).toBe('consumed');
    expect(invites.listInvites().find((i) => i.token === 'tok-consumed')?.usedByUsername).toBe(
      'joined',
    );
  });

  it('restores the partial index the rebuild drops', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_invite_tokens_unused');
    expect(idx).toBeTruthy();
  });

  it('bumps schema_version so the rebuild is one-shot', () => {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(parseInt(row!.value, 10)).toBeGreaterThanOrEqual(20);
  });
});
