// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage side of history retention (lurker-dev/RETENTION_PLAN.md): the dirty-buffer set
// that tells the sweeper where to look, and the two statements it runs. The
// scheduling lives in services/retentionSweeper.ts; this module owns the SQL
// so the statements sit next to the schema they depend on.
//
// Both statements ride idx_messages_buf_unread (buffer_id, id DESC, …) —
// count-based retention needs no new index, which is half the reason it won
// over age-based (the other half is in the plan). The messages_ad trigger
// keeps messages_fts in sync through these deletes, so search never sees a
// pruned row.

import db, { EARLY_PRUNE_TYPES_SQL } from './index.js';

// Buffers that took an insert since the sweeper last looked. In-memory on
// purpose: a restart just means the next boot seeds every buffer dirty and
// re-verifies, which is also what makes the steady sweeper double as the
// backfill when retention is first enabled on an existing database.
const dirtyBuffers = new Set<number>();

export function markBufferDirty(bufferId: number): void {
  dirtyBuffers.add(bufferId);
}

/** Drain the dirty set. The caller owns the snapshot; new inserts during a
 *  sweep land in a fresh set and are picked up next tick. */
export function takeDirtyBuffers(): number[] {
  const out = [...dirtyBuffers];
  dirtyBuffers.clear();
  return out;
}

/** Boot seeding: every buffer is suspect until the sweeper has looked once.
 *  Also the after-import catch-all — imported rows bypass insertMessage, so
 *  nothing else would ever mark their buffers. */
export function seedAllBuffersDirty(): void {
  const rows = db.prepare(`SELECT id FROM buffers`).all() as Array<{ id: number }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

/** Re-examine one user's buffers — their retention setting changed. */
export function seedUserBuffersDirty(userId: number): void {
  const rows = db.prepare(`SELECT id FROM buffers WHERE user_id = ?`).all(userId) as Array<{
    id: number;
  }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

const ownerStmt = db.prepare(`SELECT user_id AS userId FROM buffers WHERE id = ?`);

/** The buffer's owning user, or undefined for a buffer deleted since it was
 *  marked dirty (the cascade already took its messages with it). */
export function bufferOwnerId(bufferId: number): number | undefined {
  const row = ownerStmt.get(bufferId) as { userId: number } | undefined;
  return row?.userId;
}

// The newest `capLines`-th row's id: everything strictly below it is over the
// cap. OFFSET walks the buffer's own rows inside the covering index — message
// ids are a single global sequence, so id arithmetic can never answer this
// (see hasMoreThan in db/messages.ts). No row at that offset = the buffer is
// within its cap.
const boundaryStmt = db.prepare(`
  SELECT id FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
`);

export function retentionBoundaryId(bufferId: number, capLines: number): number | undefined {
  const row = boundaryStmt.get(bufferId, capLines - 1) as { id: number } | undefined;
  return row?.id;
}

// One bounded bite of the over-cap tail. Deliberately no ORDER BY in the
// subselect: everything below the boundary goes eventually, so any qualifying
// rows do, and ordering would only add sort work. The NOT EXISTS is the
// bookmark exemption — a bookmarked row below
// the boundary survives as an extra ABOVE the cap (later boundary probes walk
// past it and it never becomes deletable). It is scoped by user_id, not just
// message_id: user_bookmarks has no index on message_id alone, and a buffer
// has exactly one owner who is the only user able to bookmark its rows, so
// the (user_id, message_id) primary key answers the probe as a seek.
const deleteBatchStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
     WHERE m.buffer_id = ? AND m.id < ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

/** Delete up to `limit` over-cap rows. Returns the number deleted; a return
 *  below `limit` means this buffer's tail is done. */
export function deleteRetentionBatch(
  bufferId: number,
  boundaryId: number,
  ownerUserId: number,
  limit: number,
): number {
  return deleteBatchStmt.run(bufferId, boundaryId, ownerUserId, limit).changes;
}

// ─── The noise clock ───────────────────────────────────────────────────────

/** Every account, for the per-user noise sweep. Bounded by the user count,
 *  which is small on every edition. */
export function listUserIds(): number[] {
  return (db.prepare(`SELECT id FROM users`).all() as Array<{ id: number }>).map((r) => r.id);
}

// Per-user low-water marks for the noise sweep, persisted in app_meta as one
// JSON map (userId → the cutoff ISO the last completed sweep reached). The
// cursor is what keeps the sweep O(newly-aged rows): without it every pass
// re-walks permanently-retained index entries — bookmarked noise, and the
// entire backlog of any event_hours=0 user — from the oldest entry up, per
// user, forever. Persisted (not in-memory) because that re-walk is exactly
// what a restart must not re-pay. Deliberate edge: un-bookmarking noise that
// already fell below the owner's cursor never revisits it — the line cap
// remains its only reaper. Orphaned entries for deleted users are harmless
// and tiny.
const NOISE_CURSOR_KEY = 'retention_noise_cursors';

// ONE representation: an in-memory Map hydrated from app_meta on first use,
// with every write going through persistCursors. All readers — the sweep
// AND the insert hot path — serve from the Map, so there is no second copy
// to desync and no JSON re-parse per user per pass. `maxCursorIso` is the
// hot path's early-out watermark, and it must be the LARGEST live cursor:
// only "at or above every cursor" proves a row can't be below its owner's
// cursor, whoever the owner turns out to be. (The first version used the
// minimum — a replayed row timed between two users' cursors sailed past the
// early-out and evaded the rewind; Copilot caught it.) Live inserts sit at
// ~now, above every cursor, so the common case still skips the owner lookup.
let noiseCursors: Map<number, string> | null = null;
let maxCursorIso: string | null = null;

function loadNoiseCursors(): Map<number, string> {
  if (noiseCursors !== null) return noiseCursors;
  noiseCursors = new Map();
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(NOISE_CURSOR_KEY) as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed && typeof parsed === 'object') {
        // Keep only string values: a corrupted/hand-edited blob must degrade
        // to "sweep from the beginning", never to a non-string reaching a SQL
        // bind (which would throw every tick and trip the retention breaker).
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') noiseCursors.set(Number(k), v);
        }
      }
    } catch {
      /* unparseable = never swept */
    }
  }
  recomputeMaxCursor();
  return noiseCursors;
}

function recomputeMaxCursor(): void {
  maxCursorIso = null;
  for (const v of noiseCursors?.values() ?? []) {
    if (maxCursorIso === null || v > maxCursorIso) maxCursorIso = v;
  }
}

function persistCursors(): void {
  const map = loadNoiseCursors();
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[String(k)] = v;
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(NOISE_CURSOR_KEY, JSON.stringify(obj));
  recomputeMaxCursor();
}

/** Where this user's last completed noise sweep stopped ('' = never swept —
 *  compares below every ISO timestamp, so the first sweep walks from the
 *  beginning). */
export function getNoiseCursor(userId: number): string {
  return loadNoiseCursors().get(userId) ?? '';
}

export function setNoiseCursor(userId: number, cutoffIso: string): void {
  loadNoiseCursors().set(userId, cutoffIso);
  persistCursors();
}

/**
 * The pass-completion write, as a compare-and-advance rather than a blind
 * set: the pass's deletes only covered [fromIso, toIso), and an insert-side
 * rewind (noteNoiseInsert, below) can land DURING the pass's awaits. If the
 * cursor moved while the pass ran, blindly writing toIso would re-hide the
 * exact replayed rows the rewind exists to save — advance only when the
 * cursor is still where the pass started.
 */
export function advanceNoiseCursor(userId: number, fromIso: string, toIso: string): void {
  if (getNoiseCursor(userId) !== fromIso) return;
  setNoiseCursor(userId, toIso);
}

/** Forget a user's cursor so the next pass walks from the beginning — the
 *  data-import path, whose bulk inserts bypass insertMessage's rewind. */
export function clearNoiseCursorForUser(userId: number): void {
  const map = loadNoiseCursors();
  if (map.delete(userId)) persistCursors();
}

/**
 * Called by insertMessage for every EARLY_PRUNE_TYPES row: stored times are
 * allowed to lie in the past (server-time tags, bouncer replay), so a noise
 * row can land BELOW its owner's low-water cursor — territory the sweep
 * treats as already cleared and would otherwise never revisit, contradicting
 * the setting's "deleted once older than N hours" promise. Rewinding the
 * cursor to the row's own time puts it back in the next pass's window. The
 * ordinary live insert (time ≈ now, above every cursor) exits on the
 * watermark compare without touching the database.
 */
export function noteNoiseInsert(bufferId: number, timeIso: string): void {
  loadNoiseCursors();
  if (maxCursorIso === null || timeIso >= maxCursorIso) return;
  const ownerId = bufferOwnerId(bufferId);
  if (ownerId === undefined) return;
  const cursor = getNoiseCursor(ownerId);
  if (cursor !== '' && timeIso < cursor) setNoiseCursor(ownerId, timeIso);
}

// One bounded bite of a user's over-age noise. INDEXED BY is load-bearing
// twice over: (1) this schema never runs ANALYZE, and without the hint the
// planner drives from buffers(user_id) and walks every one of the user's
// buffers row-by-row — the exact shape the search indexes were built to kill;
// (2) SQLite refuses to prepare an INDEXED BY whose partial-index predicate
// the query no longer implies, so widening EARLY_PRUNE_TYPES without
// migrating the index fails the boot loudly instead of silently scanning.
// `time < ?` is a lexicographic compare on the stored ISO-8601 strings, the
// same ordering assumption CHATHISTORY's window queries already rely on
// (db/messages.ts loadHistoryWindow). The NOT EXISTS is the same owner-scoped
// bookmark exemption as the count sweep — and it must be here in the SELECT,
// not just "skipped at delete": an exempt row that stayed a candidate would
// make a batch of survivors read as progress forever.
const noiseDeleteStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m INDEXED BY idx_messages_noise_time
     JOIN buffers b ON b.id = m.buffer_id
     WHERE m.type IN (${EARLY_PRUNE_TYPES_SQL})
       AND m.time >= ?
       AND m.time < ?
       AND b.user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

// ─── Closed-buffer garbage collection ──────────────────────────────────────
//
// Deleting a whole buffer is the sanctioned policy-driven EXCEPTION to
// deleteBuffer's "only when no history" contract (db/buffers.ts, the
// evict/forget guards): the operator or user chose it, per
// lurker-dev/RETENTION_PLAN.md §4.5. The rules that keep it honest — and
// every one of them is enforced IN the statements, not sampled once at
// listing time, because the drain yields to the event loop between batches
// and the world moves while it does:
//   1. Eligibility re-derives from closed_at each pass (julianday, so the
//      SQLite datetime the close path writes and the ISO imports stamp both
//      compare correctly); autojoin rows are never dead buffers; server/system
//      pseudo-buffers store their lines elsewhere.
//   2. A buffer holding ANY bookmarked message is skipped at listing, and
//      the drain itself carries the owner-scoped bookmark exemption — a
//      bookmark placed mid-drain (search reaches closed buffers by design) is
//      skipped by the remaining batches while the buffer's other rows still
//      go, and the row delete then refuses because a row remains. The
//      bookmark can never be cascaded away; the buffer survives, closed,
//      holding only its bookmarked line(s).
//   3. Every drain batch and the final row delete re-check state='closed' AND
//      the age: a buffer reopened mid-drain stops losing rows on the very next
//      batch, and a reopen-then-reclose (closed_at re-stamped to now) is no
//      longer old enough. Messages drain in budgeted batches BEFORE the row
//      goes — one cascading DELETE over a big buffer would fire the FTS
//      trigger per row synchronously on the shared connection.

// The bookmark exclusion is a bound, non-correlated subquery (materialized
// once per statement) driving from the user's bookmarks — few — rather than a
// correlated probe walking each candidate buffer's rows.
const GC_AGE = `julianday(closed_at) < julianday('now') - ?`;
const GC_BOOKMARKED_BUFFERS = `
  SELECT m.buffer_id FROM user_bookmarks ub JOIN messages m ON m.id = ub.message_id
   WHERE ub.user_id = ? AND m.buffer_id IS NOT NULL`;

const gcEligibleStmt = db.prepare(`
  SELECT id FROM buffers
   WHERE user_id = ? AND state = 'closed' AND closed_at IS NOT NULL
     AND kind NOT IN ('server', 'system') AND autojoin = 0
     AND ${GC_AGE}
     AND id NOT IN (${GC_BOOKMARKED_BUFFERS})
   LIMIT ?
`);

/** Closed buffers past the user's GC age, minus any holding a bookmark. */
export function listGcEligibleBuffers(userId: number, days: number, limit: number): number[] {
  return (gcEligibleStmt.all(userId, days, userId, limit) as Array<{ id: number }>).map(
    (r) => r.id,
  );
}

const drainBufferStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
      JOIN buffers b ON b.id = m.buffer_id
     WHERE m.buffer_id = ? AND b.state = 'closed' AND ${GC_AGE.replace('closed_at', 'b.closed_at')}
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

/** Delete up to `limit` rows of a buffer being collected, while it is still
 *  closed and still old enough. A return below `limit` means there is
 *  nothing more this pass may delete: the buffer is empty, or it was
 *  reopened, or a bookmark now protects a row. */
export function drainBufferBatch(
  userId: number,
  bufferId: number,
  days: number,
  limit: number,
): number {
  return drainBufferStmt.run(bufferId, days, userId, limit).changes;
}

const gcDeleteStmt = db.prepare(`
  DELETE FROM buffers
   WHERE id = ? AND user_id = ? AND state = 'closed' AND ${GC_AGE}
     AND NOT EXISTS (SELECT 1 FROM messages WHERE buffer_id = buffers.id)
`);

/** Remove the drained buffer row; the FK cascade takes its satellite rows.
 *  Refuses — returns false, deletes nothing — if the buffer was reopened,
 *  re-closed too recently, or still holds rows (a mid-drain bookmark). */
export function gcDeleteClosedBuffer(userId: number, bufferId: number, days: number): boolean {
  return gcDeleteStmt.run(bufferId, userId, days).changes > 0;
}

// ─── Import in flight ──────────────────────────────────────────────────────
// The sweeper skips whole ticks while an import runs: the import commits
// buffers (with archive closed_at values, possibly years old) before their
// messages, one transaction per batch with event-loop yields between — GC
// would collect a half-imported buffer and the rest of the import would mint
// it anew as an open row (or fail on the bookmark FK). Same idea as the
// export gate, sourced from a counter rather than a job table.
let importsInFlight = 0;
export function beginImport(): void {
  importsInFlight++;
}
export function endImport(): void {
  importsInFlight = Math.max(0, importsInFlight - 1);
}
export function importInProgress(): boolean {
  return importsInFlight > 0;
}

/** Delete up to `limit` of this user's noise rows in [sinceIso, cutoffIso) —
 *  the low-water cursor bounds the walk to territory the last completed
 *  sweep hasn't already cleared. A return below `limit` means this user's
 *  window is done. */
export function deleteNoiseBatch(
  userId: number,
  sinceIso: string,
  cutoffIso: string,
  limit: number,
): number {
  return noiseDeleteStmt.run(sinceIso, cutoffIso, userId, userId, limit).changes;
}
