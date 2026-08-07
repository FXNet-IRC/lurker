// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration test for the schema-17 buffer_id normalization: a DB shaped like
// a real v16 install (buffers registry present, messages keyed by name, the
// name-keyed index generation live) is built RAW before db/index.ts is ever
// imported; importing it then runs the ensureColumn + mint + backfill + index
// swap against that data. app_meta pins schema_version=16 so no earlier
// recovery block interferes.
//
// Assertions are on VALUES (which buffers row each message landed on), not row
// counts — a backfill that stamps the wrong id passes any count.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-bufid-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

beforeAll(async () => {
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE networks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 6697,
      tls INTEGER NOT NULL DEFAULT 1,
      trusted_certificates INTEGER NOT NULL DEFAULT 1,
      nick TEXT NOT NULL,
      username TEXT,
      realname TEXT,
      server_password TEXT,
      autoconnect INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    -- The v16 buffers registry, as migrate() creates it.
    CREATE TABLE buffers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      target TEXT NOT NULL,
      target_folded TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      autojoin INTEGER NOT NULL DEFAULT 0,
      key TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      closed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_buffers_key
      ON buffers(user_id, IFNULL(network_id, 0), target_folded);
    -- Full v16 messages shape (the later columns were ensureColumn'd long
    -- before 16, so a real v16 DB carries them all — and the name-keyed index
    -- generation references them).
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      nick TEXT,
      text TEXT,
      kind TEXT,
      self INTEGER NOT NULL DEFAULT 0,
      extra TEXT,
      userhost TEXT,
      matched_rule_id INTEGER,
      alt INTEGER NOT NULL DEFAULT 0,
      from_ignored INTEGER NOT NULL DEFAULT 0,
      mirrored INTEGER NOT NULL DEFAULT 0,
      notable INTEGER NOT NULL DEFAULT 1,
      msgid TEXT,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_messages_unread
      ON messages(network_id, target, id DESC, type, from_ignored, notable);
    CREATE INDEX idx_messages_matched
      ON messages(network_id, target, id DESC)
      WHERE matched_rule_id IS NOT NULL;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta (key, value) VALUES ('schema_version', '16');

    INSERT INTO users (id, username) VALUES (1, 'bufid-alice'), (2, 'bufid-bob');
    INSERT INTO networks (id, user_id, name, host, nick)
      VALUES (10, 1, 'libera', 'irc.libera.chat', 'alice'),
             (20, 2, 'oftc', 'irc.oftc.net', 'bob');

    -- Registry rows the v16 world holds: canonical '#Chatty', dm 'bob', and a
    -- non-ASCII channel whose target_folded was written by JS toLowerCase
    -- (Unicode-aware) — the fold-parity tripwire.
    INSERT INTO buffers (id, user_id, network_id, target, target_folded, kind, state) VALUES
      (100, 1, 10, '#Chatty', '#chatty', 'channel', 'open'),
      (101, 1, 10, 'bob',     'bob',     'dm',      'open'),
      (102, 1, 10, '#Ärger',  '#ärger',  'channel', 'open'),
      (103, 2, 20, '#other',  '#other',  'channel', 'open');

    -- History: stray casings that must fold onto the registry rows, a target
    -- with NO registry row (orphan), the network's own :server: target, and a
    -- FOREIGN-numbered :server: stray (the shape a legacy import leaves).
    INSERT INTO messages (id, network_id, target, time, type, nick, text) VALUES
      (1, 10, '#Chatty',  '2026-01-01T00:00:00Z', 'message', 'x', 'a'),
      (2, 10, '#chatty',  '2026-01-01T00:01:00Z', 'message', 'x', 'stray case'),
      (3, 10, 'Bob',      '2026-01-01T00:02:00Z', 'message', 'Bob', 'dm stray case'),
      (4, 10, '#ÄRGER',   '2026-01-01T00:03:00Z', 'message', 'x', 'unicode stray case'),
      (5, 10, '#orphan',  '2026-01-01T00:04:00Z', 'message', 'x', 'no registry row'),
      (6, 10, ':server:10', '2026-01-01T00:05:00Z', 'notice', NULL, 'motd'),
      (7, 20, '#other',   '2026-01-01T00:06:00Z', 'message', 'y', 'd'),
      (8, 10, ':server:99', '2026-01-01T00:07:00Z', 'notice', NULL, 'imported console line');
  `);
  raw.close();

  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function bufferIdOf(messageId: number): number | null {
  return (
    db.prepare(`SELECT buffer_id AS b FROM messages WHERE id = ?`).get(messageId) as {
      b: number | null;
    }
  ).b;
}

describe('schema 17 — messages.buffer_id backfill', () => {
  it('bumps the version and records the backfill done', () => {
    const version = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(parseInt(version.value, 10)).toBeGreaterThanOrEqual(17);
    const done = db
      .prepare(`SELECT value FROM app_meta WHERE key = 'messages_bufferid_done'`)
      .get() as { value: string } | undefined;
    expect(done?.value).toBe('1');
  });

  it('leaves no NULL buffer_id behind', () => {
    expect(db.prepare(`SELECT 1 FROM messages WHERE buffer_id IS NULL LIMIT 1`).get()).toBe(
      undefined,
    );
  });

  it('folds stray casings onto the registry row (value assertions)', () => {
    expect(bufferIdOf(1)).toBe(100); // '#Chatty' exact
    expect(bufferIdOf(2)).toBe(100); // '#chatty' stray casing, same buffer
    expect(bufferIdOf(3)).toBe(101); // 'Bob' folds onto dm 'bob'
    expect(bufferIdOf(7)).toBe(103); // other user's network untouched
  });

  it('folds non-ASCII casings with the JS rule, not SQL lower()', () => {
    // '#ÄRGER'.toLowerCase() === '#ärger' (matches the registry row); SQLite
    // lower() would leave it '#ÄRGER' and this row would either go NULL or
    // mint a duplicate. Pins the registered fold function.
    expect(bufferIdOf(4)).toBe(102);
    // ...and no duplicate '#ärger'-family row was minted:
    const family = db
      .prepare(`SELECT COUNT(*) AS n FROM buffers WHERE network_id = 10 AND target LIKE '#Ä%'`)
      .all() as Array<{ n: number }>;
    expect(family[0].n).toBe(1);
  });

  it('mints a CLOSED row for an orphan target and repoints its history', () => {
    const orphan = db
      .prepare(
        `SELECT id, kind, state FROM buffers
         WHERE user_id = 1 AND network_id = 10 AND target_folded = '#orphan'`,
      )
      .get() as { id: number; kind: string; state: string } | undefined;
    expect(orphan).toBeTruthy();
    expect(orphan?.kind).toBe('channel');
    expect(orphan?.state).toBe('closed'); // never surfaced by a mint
    expect(bufferIdOf(5)).toBe(orphan?.id);
  });

  it('mints sentinel rows: :server: per network, :system: per user, open + kinded', () => {
    const server10 = db
      .prepare(
        `SELECT id, kind, state FROM buffers
         WHERE user_id = 1 AND network_id = 10 AND target = ':server:10'`,
      )
      .get() as { id: number; kind: string; state: string } | undefined;
    expect(server10?.kind).toBe('server');
    expect(server10?.state).toBe('open');
    expect(bufferIdOf(6)).toBe(server10?.id);

    const systems = db
      .prepare(
        `SELECT user_id FROM buffers WHERE kind = 'system' AND network_id IS NULL ORDER BY user_id`,
      )
      .all() as Array<{ user_id: number }>;
    expect(systems.map((s) => s.user_id)).toEqual([1, 2]);

    const server20 = db
      .prepare(`SELECT kind FROM buffers WHERE network_id = 20 AND target = ':server:20'`)
      .get() as { kind: string } | undefined;
    expect(server20?.kind).toBe('server');
  });

  it('coalesces a foreign-numbered :server: stray into the canonical sentinel, minting no hidden row', () => {
    // ':server:99' on network 10: the walk skips ':'-prefixed registry rows
    // and nothing can open one, so minting it would strand its history in a
    // hidden buffer. Instead the backfill maps it onto the network's own
    // server console — the same coalescing the live insert path applies —
    // which makes imported console history reachable.
    const server10 = db
      .prepare(`SELECT id FROM buffers WHERE network_id = 10 AND kind = 'server'`)
      .get() as { id: number };
    expect(bufferIdOf(8)).toBe(server10.id);
    const strayRows = db
      .prepare(`SELECT COUNT(*) AS n FROM buffers WHERE target = ':server:99'`)
      .get() as { n: number };
    expect(strayRows.n).toBe(0);
  });

  it('swaps the index generation: buf indexes in, name-keyed out', () => {
    const names = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(names.has('idx_messages_buf_unread')).toBe(true);
    expect(names.has('idx_messages_matched_buf')).toBe(true);
    expect(names.has('idx_messages_unread')).toBe(false);
    expect(names.has('idx_messages_matched')).toBe(false);
  });

  it('read paths resolve stray-cased requests onto the same history', async () => {
    // End-to-end through messages.ts: a divergently-cased request finds the
    // folded buffer's rows — the exact shape that used to open blank.
    const messages = await import('./messages.js');
    const events = messages.listMessages(10, '#CHATTY');
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(messages.hasMessageForTarget(10, 'BOB')).toBe(true);
    expect(messages.countNewer(10, '#chatty', 0)).toBe(2);
  });
});
