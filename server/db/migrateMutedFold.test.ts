// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// foldMutedIntoIgnoreRules runs only on databases that still carry the
// deprecated channel_notify_settings.muted column — its index.ts call is gated
// on that column existing, which is only true BEFORE the v18 satellite rebuild
// reshapes the table. So this test builds the legacy-shape tables in a scratch
// database (the function takes its db handle) rather than running against the
// live migrated schema, where the column is unrepresentable.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { foldMutedIntoIgnoreRules } from './migrateMutedFold.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-mutedfold-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let db: Database.Database;
let n = 0;

afterEach(() => db.close());

beforeEach(() => {
  db = new Database(path.join(tmpDir, `t${n++}.db`));
  db.exec(`
    CREATE TABLE channel_notify_settings (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      notify_always INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE ignored_masks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      mask TEXT COLLATE NOCASE,
      channels TEXT,
      pattern TEXT,
      pattern_kind TEXT NOT NULL DEFAULT 'substr',
      levels TEXT NOT NULL DEFAULT 'ALL',
      is_except INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
});

function setRawMuted(userId: number, networkId: number, target: string, notifyAlways: number) {
  db.prepare(
    `INSERT INTO channel_notify_settings (user_id, network_id, target, notify_always, muted, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`,
  ).run(userId, networkId, target, notifyAlways);
}

function mutedFlag(userId: number, networkId: number, target: string): number | undefined {
  return (
    db
      .prepare(
        `SELECT muted FROM channel_notify_settings WHERE user_id=? AND network_id=? AND target=?`,
      )
      .get(userId, networkId, target) as { muted: number } | undefined
  )?.muted;
}

function rules(userId: number, networkId: number): Array<{ channels: string; levels: string }> {
  return db
    .prepare(
      `SELECT channels, levels FROM ignored_masks
       WHERE user_id = ? AND network_id = ? AND mask IS NULL AND is_except = 0`,
    )
    .all(userId, networkId) as Array<{ channels: string; levels: string }>;
}

describe('foldMutedIntoIgnoreRules (issue #359 migration)', () => {
  it('converts a muted channel into a NOUNREAD+NONOTIFY ignore rule and drops the row', () => {
    setRawMuted(1, 10, '#Radio', 0); // mixed case, notify_always off

    const converted = foldMutedIntoIgnoreRules(db);
    expect(converted).toBeGreaterThanOrEqual(1);

    const muteRule = rules(1, 10).find((r) => r.channels === '#radio');
    expect(muteRule).toBeTruthy();
    expect(muteRule!.levels.split(',').toSorted()).toEqual(['NONOTIFY', 'NOUNREAD']);
    // notify_always was off, so the now-empty settings row is gone entirely.
    expect(mutedFlag(1, 10, '#Radio')).toBeUndefined();
  });

  it('preserves notify_always: clears muted, keeps the row, creates NO suppressor rule', () => {
    setRawMuted(1, 10, '#keep', 1); // notify_always on

    foldMutedIntoIgnoreRules(db);
    expect(mutedFlag(1, 10, '#keep')).toBe(0); // row kept, muted cleared
    // notify_always is the explicit opt-in to push; muting it would contradict it,
    // so no NONOTIFY/NOUNREAD rule is created for this channel.
    expect(rules(1, 10).find((r) => r.channels === '#keep')).toBeUndefined();
  });

  it('is idempotent — a second run finds nothing and adds no duplicate rule', () => {
    setRawMuted(1, 10, '#once', 0);

    expect(foldMutedIntoIgnoreRules(db)).toBeGreaterThanOrEqual(1);
    expect(foldMutedIntoIgnoreRules(db)).toBe(0); // nothing left to convert
    expect(rules(1, 10).filter((r) => r.channels === '#once')).toHaveLength(1);
  });
});
