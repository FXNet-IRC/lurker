// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

// Keyed (user_id, buffer_id) since schema 18; the snapshot joins back through
// `buffers` so the wire shape (networkId + target per draft) is unchanged.

/** A draft row returned to callers (camelCase aliased columns). */
export interface DraftRow {
  bufferId: number;
  networkId: number;
  target: string;
  body: string;
  updatedAt: string;
}

const upsertStmt = db.prepare(`
  INSERT INTO user_drafts (user_id, buffer_id, body, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, buffer_id) DO UPDATE SET
    body = excluded.body,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(`
  DELETE FROM user_drafts
   WHERE user_id = ? AND buffer_id = ?
`);

const listStmt = db.prepare(`
  SELECT d.buffer_id AS bufferId, b.network_id AS networkId, b.target AS target,
         d.body AS body, d.updated_at AS updatedAt
    FROM user_drafts d JOIN buffers b ON b.id = d.buffer_id
   WHERE d.user_id = ?
`);

/** Returns the buffer id the draft landed on (undefined = unknown buffer,
 *  no-op) so the draft-updated fanout can carry it without a second resolve. */
export function upsertDraft(
  userId: number,
  networkId: number,
  target: string,
  body: string,
): number | undefined {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return undefined;
  upsertStmt.run(userId, buffer.id, body);
  return buffer.id;
}

export function clearDraft(userId: number, networkId: number, target: string): number | undefined {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return undefined;
  clearStmt.run(userId, buffer.id);
  return buffer.id;
}

// Returns every draft for this user as plain objects — the snapshot ships
// across the wire on connect (and on a tab-visibility resync).
export function listForUser(userId: number): DraftRow[] {
  return listStmt.all(userId) as DraftRow[];
}

const getForBufferStmt = db.prepare(`
  SELECT d.buffer_id AS bufferId, b.network_id AS networkId, b.target AS target,
         d.body AS body, d.updated_at AS updatedAt
    FROM user_drafts d JOIN buffers b ON b.id = d.buffer_id
   WHERE d.user_id = ? AND d.buffer_id = ?
`);

/** Point read by buffer id — the rename/merge announcement uses this to ship
 *  the surviving draft. */
export function getDraftForBuffer(userId: number, bufferId: number): DraftRow | undefined {
  return getForBufferStmt.get(userId, bufferId) as DraftRow | undefined;
}
