// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

// Buffer favorites (the Friends/Contacts replacement). Keyed (user_id,
// buffer_id) — born id-keyed at v19, no name-keyed generation ever existed.
// Unlike pinned_buffers, position density is per USER: one global order
// spanning networks. Clients render the list as kind-filtered sections
// (queries → "Friends", channels → "Favorites"); a subset reorder preserves
// the relative order of unmentioned rows, which is what keeps the two
// filtered sections independently draggable against the one list (same
// semantics as reorderPins, issue #405).
//
// The listing shape carries (networkId, target, bufferId) per entry — the
// favorites-changed frame ships it verbatim, and target strings come joined
// from `buffers` in canonical casing.

export interface FavoriteEntry {
  networkId: number;
  target: string;
  bufferId: number;
}

const listForUserStmt = db.prepare(`
  SELECT b.network_id AS networkId, b.target AS target, f.buffer_id AS bufferId
  FROM favorite_buffers f JOIN buffers b ON b.id = f.buffer_id
  WHERE f.user_id = ?
  ORDER BY f.position ASC, b.target ASC
`);

const nextPositionStmt = db.prepare(`
  SELECT COALESCE(MAX(position), -1) + 1 AS next
  FROM favorite_buffers
  WHERE user_id = ?
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO favorite_buffers (user_id, buffer_id, position)
  VALUES (?, ?, ?)
`);

const deleteStmt = db.prepare(`
  DELETE FROM favorite_buffers
  WHERE user_id = ? AND buffer_id = ?
`);

const allForUserStmt = db.prepare(`
  SELECT buffer_id AS bufferId, position FROM favorite_buffers
  WHERE user_id = ?
  ORDER BY position ASC
`);

const setPositionStmt = db.prepare(`
  UPDATE favorite_buffers SET position = ?
  WHERE user_id = ? AND buffer_id = ?
`);

/** The user's favorites in global position order — the favorites-changed
 *  frame's payload. Entries whose network is gone have cascaded away with
 *  their buffers, so every row here resolves. */
export function listFavoritesForUser(userId: number): FavoriteEntry[] {
  return listForUserStmt.all(userId) as FavoriteEntry[];
}

const isFavoriteStmt = db.prepare(`
  SELECT 1 FROM favorite_buffers WHERE user_id = ? AND buffer_id = ?
`);

/** Is this nick the peer of a favorited DM buffer? The friend-online
 *  notification's gate — the successor to the contacts model's per-contact
 *  notify flag, now simply "they're under FRIENDS". Fold-aware via
 *  resolveBuffer; kind-checked so a favorited channel whose name happens to
 *  arrive here can never read as a person. */
export function isFavoriteDmPeer(userId: number, networkId: number, nick: string): boolean {
  const buffer = resolveBuffer(userId, networkId, nick);
  if (!buffer || buffer.kind !== 'dm') return false;
  return isFavoriteStmt.get(userId, buffer.id) !== undefined;
}

// Renumber a user's favorites dense 0..n-1, preserving order. Exported (unlike
// the pins twin) because a network delete cascades favorite rows away through
// buffers and leaves holes mid-sequence; the route re-densifies before it
// republishes. Holes are harmless for ORDER BY, but every reorder rewrite
// assumes 0..n-1 and cheap is cheap.
export function renumberFavorites(userId: number): void {
  const remaining = allForUserStmt.all(userId) as Array<{
    bufferId: number;
    position: number;
  }>;
  let i = 0;
  for (const row of remaining) {
    if (row.position !== i) setPositionStmt.run(i, userId, row.bufferId);
    i += 1;
  }
}

// Favorite at the end of the global order. Idempotent — favoriting an
// already-favorite buffer keeps its position (INSERT OR IGNORE) — and a no-op
// for a target that doesn't resolve to a buffer. A CLOSED buffer is refused
// too: close-buffer enforces close⇒unfavorite, so accepting a favorite from a
// tab that hasn't seen the close yet would mint an invisible orphan (the
// sections render favorites ∩ open) that silently resurrects as a favorite
// when the buffer reopens. Returns true when a row was added (callers skip
// the broadcast otherwise, matching the unfavorite side).
export function favoriteBuffer(userId: number, networkId: number, target: string): boolean {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer || buffer.state === 'closed') return false;
  let added = 0;
  const tx = db.transaction(() => {
    const { next } = nextPositionStmt.get(userId) as { next: number };
    added = insertStmt.run(userId, buffer.id, next).changes;
  });
  tx();
  return added > 0;
}

// Unfavorite by name regardless of the caller's casing (resolution folds it)
// and renumber to keep positions dense. Returns false when nothing matched or
// nothing was removed — callers skip the favorites-changed broadcast, same
// contract as unpinBufferCaseInsensitive's null.
export function unfavoriteBuffer(userId: number, networkId: number, target: string): boolean {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return false;
  let removed = 0;
  const tx = db.transaction(() => {
    removed = deleteStmt.run(userId, buffer.id).changes;
    if (removed > 0) renumberFavorites(userId);
  });
  tx();
  return removed > 0;
}

// Rewrite the global order from an id list. Every supplied id must currently
// be a favorite and appear at most once; an unknown or duplicated id means the
// client is working from a stale set (concurrent favorite/unfavorite from
// another tab), so return null and let the caller echo the authoritative
// order. The supplied list may be a strict SUBSET: a drag inside one
// kind-filtered section legitimately reorders only the rows that section
// shows. Supplied ids take the front in the given order; unmentioned rows
// keep their existing relative order after them — invisible cross-kind
// interleaving, but the global order is only meaningful within kind.
export function reorderFavorites(userId: number, bufferIds: number[]): FavoriteEntry[] | null {
  const currentIds = (allForUserStmt.all(userId) as Array<{ bufferId: number }>).map(
    (r) => r.bufferId,
  );
  const current = new Set(currentIds);
  const seen = new Set<number>();
  for (const id of bufferIds) {
    if (!current.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  const next = [...bufferIds, ...currentIds.filter((id) => !seen.has(id))];
  const tx = db.transaction(() => {
    let i = 0;
    for (const id of next) {
      setPositionStmt.run(i, userId, id);
      i += 1;
    }
  });
  tx();
  return listFavoritesForUser(userId);
}
