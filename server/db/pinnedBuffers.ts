// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

// Keyed (user_id, buffer_id) since schema 18; network_id stays as denormalized
// immutable scope because position density is per (user, network). The listing
// shapes still speak target strings (canonical casing, joined from `buffers`),
// so callers and the wire are unchanged.
//
// The old file's case-twin machinery (unpinBufferCaseInsensitive walking every
// casing variant) survives in name only: the PK now makes a twin
// unrepresentable, and resolution folds the caller's casing — the exported
// contract (null when nothing matched) is what callers still rely on.

const listForUserNetworkStmt = db.prepare(`
  SELECT b.target AS target
  FROM pinned_buffers p JOIN buffers b ON b.id = p.buffer_id
  WHERE p.user_id = ? AND p.network_id = ?
  ORDER BY p.position ASC, b.target ASC
`);

const listForUserStmt = db.prepare(`
  SELECT p.network_id AS networkId, b.target AS target
  FROM pinned_buffers p JOIN buffers b ON b.id = p.buffer_id
  WHERE p.user_id = ?
  ORDER BY p.network_id ASC, p.position ASC, b.target ASC
`);

const nextPositionStmt = db.prepare(`
  SELECT COALESCE(MAX(position), -1) + 1 AS next
  FROM pinned_buffers
  WHERE user_id = ? AND network_id = ?
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO pinned_buffers (user_id, buffer_id, network_id, position)
  VALUES (?, ?, ?, ?)
`);

const deleteStmt = db.prepare(`
  DELETE FROM pinned_buffers
  WHERE user_id = ? AND buffer_id = ?
`);

const allForUserNetworkStmt = db.prepare(`
  SELECT buffer_id AS bufferId, position FROM pinned_buffers
  WHERE user_id = ? AND network_id = ?
  ORDER BY position ASC
`);

const setPositionStmt = db.prepare(`
  UPDATE pinned_buffers SET position = ?
  WHERE user_id = ? AND buffer_id = ?
`);

export function listPinnedForUserNetwork(userId: number, networkId: number): string[] {
  return (listForUserNetworkStmt.all(userId, networkId) as Array<{ target: string }>).map(
    (r) => r.target,
  );
}

const listWithIdsStmt = db.prepare(`
  SELECT p.buffer_id AS bufferId, b.target AS target
  FROM pinned_buffers p JOIN buffers b ON b.id = p.buffer_id
  WHERE p.user_id = ? AND p.network_id = ?
  ORDER BY p.position ASC, b.target ASC
`);

/** The pinned set with both wire representations — the pins-changed frame
 *  ships `pinned` (names) and `pinnedIds` (parallel-indexed buffer ids). */
export function listPinnedWithIds(
  userId: number,
  networkId: number,
): Array<{ bufferId: number; target: string }> {
  return listWithIdsStmt.all(userId, networkId) as Array<{ bufferId: number; target: string }>;
}

export function listPinnedForUser(userId: number): Map<number, string[]> {
  const byNetwork = new Map<number, string[]>();
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    target: string;
  }>) {
    if (!byNetwork.has(row.networkId)) byNetwork.set(row.networkId, []);
    byNetwork.get(row.networkId)!.push(row.target);
  }
  return byNetwork;
}

// Renumber a (user, network)'s pins dense 0..n-1, preserving order.
function renumber(userId: number, networkId: number): void {
  const remaining = allForUserNetworkStmt.all(userId, networkId) as Array<{
    bufferId: number;
    position: number;
  }>;
  let i = 0;
  for (const row of remaining) {
    if (row.position !== i) setPositionStmt.run(i, userId, row.bufferId);
    i += 1;
  }
}

// Returns the new ordered target list for the (user, network). No-op if the
// row already exists (idempotent — second pin of the same target keeps the
// existing position rather than creating a duplicate or moving it), or if the
// target doesn't resolve to a buffer at all.
export function pinBuffer(userId: number, networkId: number, target: string): string[] {
  const buffer = resolveBuffer(userId, networkId, target);
  if (buffer) {
    const tx = db.transaction(() => {
      const { next } = nextPositionStmt.get(userId, networkId) as { next: number };
      insertStmt.run(userId, buffer.id, networkId, next);
    });
    tx();
  }
  return listPinnedForUserNetwork(userId, networkId);
}

// Unpin and renumber remaining rows to keep positions dense (0..n-1). Returns
// the new ordered target list.
export function unpinBuffer(userId: number, networkId: number, target: string): string[] {
  const buffer = resolveBuffer(userId, networkId, target);
  if (buffer) {
    const tx = db.transaction(() => {
      deleteStmt.run(userId, buffer.id);
      renumber(userId, networkId);
    });
    tx();
  }
  return listPinnedForUserNetwork(userId, networkId);
}

// Unpin by name regardless of the caller's casing. Pre-normalization this had
// to sweep every stored casing variant of the target; resolution now folds the
// name and the (user_id, buffer_id) key makes variants unrepresentable, so it
// is a single delete. The contract callers rely on is unchanged: the new
// ordered list when a row was removed, null when nothing matched (used to skip
// the pins-changed broadcast).
export function unpinBufferCaseInsensitive(
  userId: number,
  networkId: number,
  target: string,
): string[] | null {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return null;
  let removed = 0;
  const tx = db.transaction(() => {
    removed = deleteStmt.run(userId, buffer.id).changes;
    if (removed > 0) renumber(userId, networkId);
  });
  tx();
  if (removed === 0) return null;
  return listPinnedForUserNetwork(userId, networkId);
}

// Rewrite the order for a (user, network). Every supplied target must currently
// be pinned (and appear at most once); an unknown or duplicated target means the
// client is working from a stale set (e.g. a concurrent pin/unpin from another
// tab), so we return null and let the caller echo the authoritative order.
//
// The supplied list may be a strict SUBSET of the pinned set. The client only
// renders pins that resolve to a visible buffer — it drops any pin whose buffer
// is closed/parted — so a drag legitimately reorders only the rows the user can
// see. We honor
// that order for the supplied targets and keep the unmentioned ("hidden") pins
// after them in their existing relative order. Requiring an exact set match
// instead made a single invisible orphan pin wedge every reorder for that
// network (issue #405). On success returns the new full ordered target list
// (canonical casing, which may differ from what the client sent).
export function reorderPins(userId: number, networkId: number, targets: string[]): string[] | null {
  const pinnedIds = (
    allForUserNetworkStmt.all(userId, networkId) as Array<{ bufferId: number }>
  ).map((r) => r.bufferId);
  const pinned = new Set(pinnedIds);
  const seen = new Set<number>();
  const suppliedIds: number[] = [];
  for (const t of targets) {
    const buffer = resolveBuffer(userId, networkId, t);
    if (!buffer || !pinned.has(buffer.id) || seen.has(buffer.id)) return null;
    seen.add(buffer.id);
    suppliedIds.push(buffer.id);
  }
  const next = [...suppliedIds, ...pinnedIds.filter((id) => !seen.has(id))];
  const tx = db.transaction(() => {
    let i = 0;
    for (const id of next) {
      setPositionStmt.run(i, userId, id);
      i += 1;
    }
  });
  tx();
  return listPinnedForUserNetwork(userId, networkId);
}
