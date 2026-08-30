// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-buffer override of data.retention.lines (lurker-dev/RETENTION_PLAN.md).
// Sparse rows in the channelNotify idiom: absence = inherit the global
// setting, max_lines 0 = an explicit "unlimited here". The override may sit
// ABOVE the user's global — that asymmetry is the point ("keep everything in
// #friends, a day in the firehose") — and both directions clamp to the
// operator ceiling inside effectiveRetentionLines, never here.

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

const getByBufferStmt = db.prepare(`
  SELECT max_lines AS maxLines FROM buffer_retention WHERE user_id = ? AND buffer_id = ?
`);

const upsertStmt = db.prepare(`
  INSERT INTO buffer_retention (user_id, buffer_id, max_lines, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, buffer_id)
  DO UPDATE SET max_lines = excluded.max_lines, updated_at = excluded.updated_at
`);

const deleteStmt = db.prepare(`
  DELETE FROM buffer_retention WHERE user_id = ? AND buffer_id = ?
`);

/** The stored override for one buffer, or null when the buffer inherits. */
export function getBufferRetentionOverride(userId: number, bufferId: number): number | null {
  const row = getByBufferStmt.get(userId, bufferId) as { maxLines: number } | undefined;
  return row ? row.maxLines : null;
}

/** Name-addressed read for the WS/REST surface. */
export function getBufferRetentionByTarget(
  userId: number,
  networkId: number,
  target: string,
): { bufferId: number; maxLines: number | null } | null {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return null;
  return { bufferId: buffer.id, maxLines: getBufferRetentionOverride(userId, buffer.id) };
}

/** Set (or, with null, clear) the override by buffer id. */
export function setBufferRetentionById(
  userId: number,
  bufferId: number,
  maxLines: number | null,
): void {
  if (maxLines === null) {
    deleteStmt.run(userId, bufferId);
  } else {
    upsertStmt.run(userId, bufferId, maxLines);
  }
}

/** Name-addressed setter. Returns the buffer id, or null when the target
 *  doesn't resolve to a buffer this user owns. */
export function setBufferRetention(
  userId: number,
  networkId: number,
  target: string,
  maxLines: number | null,
): number | null {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return null;
  setBufferRetentionById(userId, buffer.id, maxLines);
  return buffer.id;
}

// The recent-pace hint for the per-buffer UI: newest stored time vs the time
// at OFFSET min(count,1000)-1, both read off idx_messages_buf_unread. Answers
// "≈ how long does a given cap last HERE"; null for a buffer with fewer than
// two rows (no rate to state).
const newestTimeStmt = db.prepare(`
  SELECT time FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT 1
`);
const rowPairStmt = db.prepare(`
  SELECT COUNT(*) AS n, MIN(time) AS oldest FROM (
    SELECT time FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT 1000
  )
`);

export function recentLinesPerDay(bufferId: number): number | null {
  const newest = newestTimeStmt.get(bufferId) as { time: string } | undefined;
  if (!newest) return null;
  const sample = rowPairStmt.get(bufferId) as { n: number; oldest: string | null };
  if (!sample.oldest || sample.n < 2) return null;
  const spanMs = Date.parse(newest.time) - Date.parse(sample.oldest);
  if (!Number.isFinite(spanMs) || spanMs <= 0) return null;
  return Math.round((sample.n / spanMs) * 24 * 3_600_000);
}
