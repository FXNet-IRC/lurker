// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration test for the schema-18 satellite rebuild: a DB shaped like a
// real v17 install (messages already buffer_id-keyed, view-state satellites
// still name-keyed) is built RAW before db/index.ts is imported; importing it
// runs the rebuild against that data. app_meta pins schema_version=17 and the
// v17 done-flag so no earlier block interferes.
//
// The interesting inputs are the ones the rebuild's merge policies exist for:
// case-twin rows (the old binary PKs let '#Chan' and '#chan' coexist),
// sentinel read pointers (:system: with NULL network, :server:<id>), and a
// row whose target resolves to nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-satrebuild-'));
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
      closed_at TEXT
    );
    CREATE UNIQUE INDEX idx_buffers_key
      ON buffers(user_id, IFNULL(network_id, 0), target_folded);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      buffer_id INTEGER,
      target TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      nick TEXT, text TEXT, kind TEXT,
      self INTEGER NOT NULL DEFAULT 0,
      extra TEXT, userhost TEXT, matched_rule_id INTEGER,
      alt INTEGER NOT NULL DEFAULT 0,
      from_ignored INTEGER NOT NULL DEFAULT 0,
      mirrored INTEGER NOT NULL DEFAULT 0,
      notable INTEGER NOT NULL DEFAULT 1,
      msgid TEXT
    );
    CREATE INDEX idx_messages_buf_unread
      ON messages(buffer_id, id DESC, type, from_ignored, notable);
    CREATE INDEX idx_messages_matched_buf
      ON messages(buffer_id, id DESC) WHERE matched_rule_id IS NOT NULL;

    -- v17-shape satellites (name-keyed).
    CREATE TABLE buffer_reads (
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      target TEXT NOT NULL,
      last_read_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_before_message_id INTEGER,
      cleared_at TEXT,
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE input_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pinned_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE nicklist_collapsed (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE channel_notify_settings (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      notify_always INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE user_drafts (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );

    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta (key, value) VALUES
      ('schema_version', '17'),
      ('messages_bufferid_done', '1'),
      ('messages_bufferid_cursor', '0');

    INSERT INTO users (id, username) VALUES (1, 'sat-alice');
    INSERT INTO networks (id, user_id, name, host, nick)
      VALUES (10, 1, 'libera', 'irc.libera.chat', 'alice');

    -- v17 registry: canonical rows + the sentinels v17 minted.
    INSERT INTO buffers (id, user_id, network_id, target, target_folded, kind, state) VALUES
      (100, 1, 10, '#Chan',  '#chan',  'channel', 'open'),
      (101, 1, 10, 'bob',    'bob',    'dm',      'open'),
      (102, 1, 10, ':server:10', ':server:10', 'server', 'open'),
      (103, 1, NULL, ':system:', ':system:', 'system', 'open');

    -- Case twins across the satellites, plus sentinel pointers. The '#Chan'
    -- pair carries markers on BOTH twins, with the FURTHER boundary paired
    -- with the EARLIER timestamp — the shape that catches a merge pairing one
    -- twin's boundary with the other's cleared_at (independent MAXes would
    -- produce boundary 40 + timestamp 2026-03-01, an impossible row).
    INSERT INTO buffer_reads (user_id, network_id, target, last_read_message_id,
                              cleared_before_message_id, cleared_at) VALUES
      (1, 10, '#Chan', 50, 25, '2026-03-01T00:00:00Z'),
      (1, 10, '#chan', 90, 40, '2026-01-01T00:00:00Z'),  -- twin: further pointer + boundary
      (1, 10, ':server:10', 7, NULL, NULL),
      (1, NULL, ':system:', 3, NULL, NULL),
      (1, 10, '#vanished', 12, NULL, NULL);              -- no registry row: minted closed

    INSERT INTO input_history (id, user_id, network_id, target, text) VALUES
      (1, 1, 10, '#Chan', 'first'),
      (2, 1, 10, '#chan', 'second'),
      (3, 1, 10, 'bob', 'dm line');

    INSERT INTO pinned_buffers (user_id, network_id, target, position) VALUES
      (1, 10, '#chan', 0),   -- twin of #Chan: earliest slot wins
      (1, 10, 'bob',   1),
      (1, 10, '#Chan', 2);

    INSERT INTO nicklist_collapsed (user_id, network_id, target, collapsed) VALUES
      (1, 10, '#Chan', 0),
      (1, 10, '#chan', 1);   -- MAX wins: stays collapsed

    INSERT INTO channel_notify_settings (user_id, network_id, target, notify_always, muted) VALUES
      (1, 10, '#Chan', 1, 0);

    INSERT INTO user_drafts (user_id, network_id, target, body, updated_at) VALUES
      (1, 10, '#Chan', 'older draft', '2026-01-01T00:00:00Z'),
      (1, 10, '#chan', 'newer draft', '2026-02-01T00:00:00Z'), -- latest wins
      -- Foreign-numbered :server: stray (legacy-import shape): must coalesce
      -- onto the network's canonical sentinel, not drop or mint a hidden row.
      (1, 10, ':server:99', 'console draft', '2026-03-01T00:00:00Z');
  `);
  raw.close();

  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('schema 18 — satellite rebuild', () => {
  it('bumps the version and drops every satellite name column', () => {
    const v = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(parseInt(v.value, 10)).toBeGreaterThanOrEqual(18);
    for (const t of [
      'buffer_reads',
      'input_history',
      'pinned_buffers',
      'nicklist_collapsed',
      'channel_notify_settings',
      'user_drafts',
    ]) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
        (c) => `${t}.${c.name}`,
      );
      expect(cols).toContain(`${t}.buffer_id`);
      expect(cols).not.toContain(`${t}.target`);
    }
  });

  it('merges read-pointer case twins: furthest pointer, winning boundary KEEPS ITS OWN timestamp', async () => {
    const { getReadState, getClearedState } = await import('./bufferReads.js');
    expect(getReadState(1, 10, '#CHAN')).toBe(90);
    // Boundary 40 wins (further than 25), and its cleared_at rides with it —
    // NOT the other twin's later 2026-03-01 timestamp.
    expect(getClearedState(1, 10, '#chan')).toEqual({
      clearedBeforeId: 40,
      clearedAt: '2026-01-01T00:00:00Z',
    });
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM buffer_reads WHERE user_id = 1 AND buffer_id = 100`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('repoints sentinel read pointers onto the sentinel rows', async () => {
    const { getReadState } = await import('./bufferReads.js');
    expect(getReadState(1, 10, ':server:10')).toBe(7);
    expect(getReadState(1, null, ':system:')).toBe(3);
    const sysRow = db
      .prepare(`SELECT buffer_id AS b FROM buffer_reads WHERE user_id = 1 AND buffer_id = 103`)
      .get() as { b: number } | undefined;
    expect(sysRow?.b).toBe(103);
  });

  it('mints a closed row for a read pointer whose buffer the registry forgot', () => {
    const vanished = db
      .prepare(
        `SELECT id, state FROM buffers WHERE user_id = 1 AND network_id = 10
         AND target_folded = '#vanished'`,
      )
      .get() as { id: number; state: string } | undefined;
    expect(vanished?.state).toBe('closed');
    const read = db
      .prepare(`SELECT last_read_message_id AS lr FROM buffer_reads WHERE buffer_id = ?`)
      .get(vanished?.id) as { lr: number } | undefined;
    expect(read?.lr).toBe(12);
  });

  it('preserves input-history ids and repoints case twins onto one buffer', async () => {
    const { listRecent } = await import('./inputHistory.js');
    expect(listRecent(1, 10, '#chan')).toEqual(['first', 'second']);
    expect(listRecent(1, 10, 'bob')).toEqual(['dm line']);
    const ids = db
      .prepare(`SELECT id FROM input_history WHERE buffer_id = 100 ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(ids.map((r) => r.id)).toEqual([1, 2]);
  });

  it('merges pin twins keeping the earliest slot, then re-densifies positions', async () => {
    const { listPinnedForUserNetwork } = await import('./pinnedBuffers.js');
    // '#chan' (pos 0) and '#Chan' (pos 2) merge into position 0; 'bob' slides
    // from 1 into the dense order after renumbering.
    expect(listPinnedForUserNetwork(1, 10)).toEqual(['#Chan', 'bob']);
    const rows = db
      .prepare(`SELECT position FROM pinned_buffers WHERE user_id = 1 ORDER BY position`)
      .all() as Array<{ position: number }>;
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('merges nicklist twins with MAX(collapsed)', async () => {
    const { listCollapsedForUserNetwork } = await import('./nicklistCollapsed.js');
    expect(listCollapsedForUserNetwork(1, 10)).toEqual({ '#Chan': true });
  });

  it('keeps notify_always and drops the dead muted column', async () => {
    const { getChannelNotifyAlways } = await import('./channelNotify.js');
    expect(getChannelNotifyAlways(1, 10, '#chan')).toBe(true);
  });

  it('the LATEST draft wins a case-twin merge', async () => {
    const { listForUser } = await import('./drafts.js');
    const drafts = listForUser(1);
    expect(drafts).toHaveLength(2);
    expect(drafts.find((d) => d.target === '#Chan')).toMatchObject({
      networkId: 10,
      body: 'newer draft',
    });
  });

  it('coalesces a foreign-numbered :server: stray onto the canonical sentinel', async () => {
    const { listForUser } = await import('./drafts.js');
    // The ':server:99' draft (a legacy-import artifact) attaches to this
    // network's real console — the same coalescing the v17 messages backfill
    // and the live insert path apply — rather than dropping or minting a
    // hidden ':' row.
    expect(listForUser(1).find((d) => d.target === ':server:10')).toMatchObject({
      body: 'console draft',
    });
    expect(db.prepare(`SELECT 1 FROM buffers WHERE target = ':server:99'`).get()).toBe(undefined);
  });
});
