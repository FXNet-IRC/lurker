// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

// Keyed (user_id, buffer_id) since schema 18. Signatures unchanged — callers
// hold names; resolution happens here, scoped to the CALLER's userId (not
// derived from the network) so a mismatched (userId, networkId) pair can
// never write rows referencing another user's buffers — the satellite FK
// points at buffers(id) alone, so ownership is this layer's job. A miss on
// add is a silent drop (input history for a buffer that doesn't exist has
// nowhere to live and nothing to replay it).

const insertStmt = db.prepare(`
  INSERT INTO input_history (user_id, buffer_id, text)
  VALUES (?, ?, ?)
`);

const listRecentStmt = db.prepare(`
  SELECT text FROM input_history
  WHERE user_id = ? AND buffer_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

export function addEntry(userId: number, networkId: number, target: string, text: string): void {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return;
  insertStmt.run(userId, buffer.id, text);
}

// Returns the `limit` most recent entries, oldest-first — the order the client
// wants for up-arrow walking (index N-1 is newest, walk backwards toward 0).
// The table itself is uncapped; this slice is just what we ship on snapshot.
export function listRecent(
  userId: number,
  networkId: number,
  target: string,
  limit = 200,
): string[] {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return [];
  return (listRecentStmt.all(userId, buffer.id, limit) as Array<{ text: string }>)
    .map((row) => row.text)
    .toReversed();
}
