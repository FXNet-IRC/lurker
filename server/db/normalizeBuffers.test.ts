// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Unit tests for the v17 normalization bodies, against a RAW database — the
// functions take their db handle precisely so the kill/resume behavior can be
// exercised without booting the whole module. The properties pinned here are
// the ones the migration's safety argument rests on:
//
//   - a mid-run kill loses at most one chunk and the next run RESUMES (the
//     cursor is committed inside each chunk's transaction),
//   - resuming never rewrites rows that were already stamped,
//   - the whole pass is idempotent once the done-flag is set,
//   - the SQL-side fold is the JS rule (Unicode), not SQLite lower() (ASCII).

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {
  mintSentinelBuffers,
  mintOrphanBuffersFromMessages,
  backfillMessagesBufferId,
  normalizeMessagesBufferIds,
  messagesBackfillDone,
} from './normalizeBuffers.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-normalize-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let db: Database.Database;
let n = 0;

afterEach(() => db.close());

function freshDb(): Database.Database {
  const d = new Database(path.join(tmpDir, `t${n++}.db`));
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE networks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL);
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE UNIQUE INDEX idx_buffers_key
      ON buffers(user_id, IFNULL(network_id, 0), target_folded);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      buffer_id INTEGER,
      target TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      type TEXT NOT NULL DEFAULT 'message'
    );
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO users (id, username) VALUES (1, 'u');
    INSERT INTO networks (id, user_id) VALUES (10, 1);
    INSERT INTO buffers (user_id, network_id, target, target_folded, kind)
      VALUES (1, 10, '#chan', '#chan', 'channel');
  `);
  return d;
}

function seedMessages(count: number): void {
  const ins = db.prepare(`INSERT INTO messages (network_id, target) VALUES (10, '#chan')`);
  for (let i = 0; i < count; i += 1) ins.run();
}

function nullCount(): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE buffer_id IS NULL`).get() as {
      c: number;
    }
  ).c;
}

beforeEach(() => {
  db = freshDb();
});

describe('backfillMessagesBufferId — kill and resume', () => {
  it('persists partial progress and resumes without rewriting done rows', () => {
    seedMessages(100);

    const first = backfillMessagesBufferId(db, { chunk: 30, abortAfterChunks: 1 });
    expect(first.complete).toBe(false);
    expect(first.updated).toBe(30);
    expect(nullCount()).toBe(70);
    const cursor = db
      .prepare(`SELECT value FROM app_meta WHERE key = 'messages_bufferid_cursor'`)
      .get() as { value: string };
    expect(Number(cursor.value)).toBe(30);
    expect(messagesBackfillDone(db)).toBe(false);

    // The "next boot": same call, no abort. `updated` counts only rows this
    // run stamped — a resume that re-wrote the first chunk would report 100.
    const second = backfillMessagesBufferId(db, { chunk: 30 });
    expect(second.complete).toBe(true);
    expect(second.updated).toBe(70);
    expect(nullCount()).toBe(0);
    expect(messagesBackfillDone(db)).toBe(true);
  });

  it('is a no-op once the done-flag is set', () => {
    seedMessages(5);
    expect(backfillMessagesBufferId(db, {}).complete).toBe(true);
    const again = backfillMessagesBufferId(db, {});
    expect(again).toEqual({ updated: 0, complete: true });
  });

  it('completes an empty table immediately', () => {
    expect(backfillMessagesBufferId(db, {}).complete).toBe(true);
    expect(messagesBackfillDone(db)).toBe(true);
  });

  it('leaves unresolvable rows NULL and does not set the done-flag', () => {
    db.exec(`INSERT INTO messages (network_id, target) VALUES (99, '#ghost')`); // no such network
    const result = backfillMessagesBufferId(db, {});
    expect(result.complete).toBe(false);
    expect(messagesBackfillDone(db)).toBe(false);
  });
});

describe('the fold parity tripwire', () => {
  it('resolves non-ASCII case variants with the JS rule', () => {
    db.exec(`
      INSERT INTO buffers (user_id, network_id, target, target_folded, kind)
        VALUES (1, 10, '#Ärger', '#ärger', 'channel');
      INSERT INTO messages (network_id, target) VALUES (10, '#ÄRGER');
    `);
    const result = backfillMessagesBufferId(db, {});
    // SQLite lower('#ÄRGER') = '#ÄRGER' — under that fold this row stays NULL
    // and complete would be false. The registered JS-parity function is what
    // makes it resolve.
    expect(result.complete).toBe(true);
    const row = db
      .prepare(
        `SELECT b.target_folded AS f FROM messages m JOIN buffers b ON b.id = m.buffer_id
         WHERE m.target = '#ÄRGER'`,
      )
      .get() as { f: string };
    expect(row.f).toBe('#ärger');
  });
});

describe('mints', () => {
  it('mintSentinelBuffers is idempotent and kinds the rows', () => {
    mintSentinelBuffers(db);
    mintSentinelBuffers(db);
    const rows = db
      .prepare(`SELECT target, kind, state, network_id FROM buffers WHERE target LIKE ':%'`)
      .all() as Array<{ target: string; kind: string; state: string; network_id: number | null }>;
    expect(rows).toHaveLength(2);
    const system = rows.find((r) => r.target === ':system:');
    expect(system?.kind).toBe('system');
    expect(system?.network_id).toBe(null);
    const server = rows.find((r) => r.target === ':server:10');
    expect(server?.kind).toBe('server');
    expect(server?.state).toBe('open');
  });

  it('mintOrphanBuffersFromMessages mints CLOSED rows for unmatched targets only', () => {
    db.exec(`
      INSERT INTO messages (network_id, target) VALUES (10, '#chan');
      INSERT INTO messages (network_id, target) VALUES (10, 'Stray');
      INSERT INTO messages (network_id, target) VALUES (10, ':server:99');
    `);
    const minted = mintOrphanBuffersFromMessages(db);
    // '#chan' already had a row; ':server:99' is deliberately skipped — a
    // minted ':' row would be hidden from the walk and unopenable, so the
    // backfill coalesces those onto the canonical sentinel instead.
    expect(minted).toBe(1);
    const row = db
      .prepare(`SELECT kind, state FROM buffers WHERE target_folded = 'stray'`)
      .get() as { kind: string; state: string };
    expect(row.kind).toBe('dm');
    expect(row.state).toBe('closed');
    expect(db.prepare(`SELECT 1 FROM buffers WHERE target = ':server:99'`).get()).toBe(undefined);
  });

  it('the backfill coalesces :server: strays onto the canonical sentinel', () => {
    mintSentinelBuffers(db);
    db.exec(`INSERT INTO messages (network_id, target) VALUES (10, ':server:77')`);
    const result = backfillMessagesBufferId(db, {});
    expect(result.complete).toBe(true);
    const mapped = db
      .prepare(
        `SELECT b.target AS t FROM messages m JOIN buffers b ON b.id = m.buffer_id
         WHERE m.target = ':server:77'`,
      )
      .get() as { t: string };
    expect(mapped.t).toBe(':server:10');
  });

  it('normalizeMessagesBufferIds resolves rows minted after a first pass', () => {
    // The straggler sweep: rows behind the cursor whose buffers row only
    // exists after a re-mint still get stamped.
    db.exec(`INSERT INTO messages (network_id, target) VALUES (10, 'newcomer')`);
    const result = normalizeMessagesBufferIds(db);
    expect(result.complete).toBe(true);
    expect(nullCount()).toBe(0);
  });
});
