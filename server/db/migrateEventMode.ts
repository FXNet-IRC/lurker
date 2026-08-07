// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type Database from 'better-sqlite3';
import { EVENT_MODE_KEY, EVENT_MODE_KEY_MOBILE, type EventMode } from '../../shared/eventFilter.js';

const LEGACY_KEY = 'chat.smart_filter';

// Issue #666: the standalone smart-filter master switch became the middle rung of
// the `chat.events` tier. This is a RENAME OF MEANING, not just of a key, so it
// needs a real migration — the registry no longer has a `chat.smart_filter`
// entry, and a stored row under a key nothing reads is indistinguishable from
// never having set it. Skipping this would silently put every person who
// deliberately turned smart filtering on back onto "show me everything", which
// is precisely the failure `chat.image_modal.enabled` carries a comment about.
//
// Both tier keys are written, not just the desktop one. Smart filtering was a
// single global preference before the tier split it by device class, so writing
// only `chat.events` would quietly downgrade these users' phones to `all` — a
// behavior change on a device they never touched a setting for.
//
// Idempotent and self-terminating: the legacy rows are deleted as they convert,
// so a re-run finds nothing. No schema_version gate — a version-gated block
// can't fix a DB already stamped past it, and this one self-heals.
//
// Returns the number of users migrated.
export function migrateSmartFilterToEventMode(db: Database.Database): number {
  const rows = db
    .prepare(`SELECT user_id AS userId, value FROM user_settings WHERE key = ?`)
    .all(LEGACY_KEY) as Array<{ userId: number; value: string }>;
  if (!rows.length) return 0;

  const readKey = db.prepare(
    `SELECT value FROM user_settings WHERE user_id = ? AND key = ?`,
  ) as Database.Statement;
  const writeKey = db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const dropLegacy = db.prepare(`DELETE FROM user_settings WHERE user_id = ? AND key = ?`);

  const migrate = db.transaction((pending: Array<{ userId: number; value: string }>) => {
    let migrated = 0;
    for (const row of pending) {
      let smart = false;
      try {
        smart = JSON.parse(row.value) === true;
      } catch {
        // A malformed row is treated as unset — the same thing getUserSettings
        // does with it — so it converts to the default tier and stops being a
        // row nothing can read.
      }
      // Only `smart` needs storing. `all` IS the registry default, and the server
      // drops rows equal to their default on normal writes — persisting one here
      // would light the Settings UI's "modified" marker on a setting the user
      // never chose. Checked before the point reads below so the common
      // (smart-filter-off) row costs nothing but its delete.
      const mode: EventMode = smart ? 'smart' : 'all';
      if (mode === 'smart') {
        for (const key of [EVENT_MODE_KEY, EVENT_MODE_KEY_MOBILE]) {
          // Don't clobber a tier the user has ALREADY set. That happens when a
          // client running the new build wrote a tier before this migration ran
          // (a mid-upgrade session, or a DB restored from a mixed backup) — their
          // explicit newer choice outranks a legacy row we're here to retire.
          const existing = readKey.get(row.userId, key) as { value: string } | undefined;
          if (existing !== undefined) continue;
          writeKey.run(row.userId, key, JSON.stringify(mode));
        }
      }
      dropLegacy.run(row.userId, LEGACY_KEY);
      migrated += 1;
    }
    return migrated;
  });

  // BEGIN IMMEDIATE, not deferred: this transaction opens with a READ (the
  // don't-clobber probe) before its first write. Under a deferred BEGIN that read
  // establishes the snapshot, and on a hosted cell Litestream's once-a-second sync
  // writes its own bookkeeping in that window — staling the snapshot so the first
  // write dies with SQLITE_BUSY_SNAPSHOT, which is non-retryable (the 2026-07-19
  // roswell incident, see the note in db/index.ts). The caller swallows the throw
  // as a warning, so the cost isn't a crash: it's this migration being silently
  // skipped for that boot, leaving everyone who had smart filtering on running
  // with it off until some later boot wins the race.
  return migrate.immediate(rows) as number;
}
