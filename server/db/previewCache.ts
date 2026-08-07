// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Bookkeeping for the preview BYTE cache — what is stored, how big it is, and
// when it was last read. The bytes themselves live on disk or in a bucket; this
// table holds only the index (see the schema note in db/index.ts for why blobs
// here would be a mistake on a Litestream-replicated database).
//
// ⚠ Existence is answered from HERE, never by asking the backend. The whole
// point of the cache is to remove a round trip, and a HEAD to S3 on every byte
// request would just trade an origin fetch for a bucket fetch. The cost of that
// choice is that the table can disagree with reality — a bucket emptied by a
// lifecycle rule, a data directory wiped between deploys — so every read path
// treats "row says yes, backend says no" as an ordinary miss and repairs the
// row rather than failing the request. See `forget`.

import db from './index.js';
import { NOW_ISO } from './linkPreviews.js';

// ⚠ Hoisted, as every other db/ module does. `db.prepare()` re-parses the SQL on
// each call, and these run on the byte path — once per cache hit and twice per
// store. better-sqlite3 caches nothing for us.
const SELECT_ENTRY = db.prepare<[string], Row>(
  `SELECT cache_key, backend, content_type, size, created_at FROM preview_cache WHERE cache_key = ?`,
);
const TOUCH_ENTRY = db.prepare<[string]>(
  `UPDATE preview_cache SET last_access = ${NOW_ISO}
    WHERE cache_key = ? AND last_access <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`,
);
const UPSERT_ENTRY = db.prepare<[string, string, string, number]>(
  `INSERT INTO preview_cache (cache_key, backend, content_type, size)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(cache_key) DO UPDATE SET
     backend = excluded.backend,
     content_type = excluded.content_type,
     size = excluded.size,
     last_access = ${NOW_ISO}`,
);
const DELETE_ENTRY = db.prepare<[string]>(`DELETE FROM preview_cache WHERE cache_key = ?`);
const SUM_BYTES = db.prepare<[string], { total: number | null }>(
  `SELECT SUM(size) AS total FROM preview_cache WHERE backend = ?`,
);
const COLDEST = db.prepare<[string, number], Row>(
  `SELECT cache_key, backend, content_type, size, created_at FROM preview_cache
    WHERE backend = ? ORDER BY last_access ASC, created_at ASC LIMIT ?`,
);
const COUNT_ALL = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM preview_cache`);
const EXPIRED = db.prepare<[string, string, number], Row>(
  `SELECT cache_key, backend, content_type, size, created_at FROM preview_cache
    WHERE backend = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
);
const FOREIGN = db.prepare<[string, number], Row>(
  `SELECT cache_key, backend, content_type, size, created_at FROM preview_cache
    WHERE backend <> ? LIMIT ?`,
);

export interface CacheEntry {
  key: string;
  backend: string;
  contentType: string;
  size: number;
  /** When it was stored. Read by the age bound in the cache's `lookup`. */
  createdAt: string;
}

interface Row {
  cache_key: string;
  backend: string;
  content_type: string;
  size: number;
  created_at: string;
}

/**
 * Look an object up, and mark it read.
 *
 * ⚠ `last_access` is only written when it is meaningfully stale. A touch per hit
 * turns a read-only path into a write on the one shared connection, and the
 * eviction order does not care about minutes — it cares about which objects are
 * cold over days. An hour of granularity costs eviction nothing and removes the
 * write from the hot path almost entirely.
 */
export function lookupCached(key: string): CacheEntry | null {
  const row = SELECT_ENTRY.get(key);
  if (!row) return null;

  TOUCH_ENTRY.run(key);

  return {
    key: row.cache_key,
    backend: row.backend,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

/**
 * Look an object up WITHOUT marking it read.
 *
 * ⚠⚠ A separate function rather than a flag on `lookupCached`, because the two
 * have opposite hot paths and getting it wrong is a write amplification bug. This
 * one is called at DESCRIPTOR-MINT time — once per image per resolve, and once
 * per image per row of a backlog snapshot when Part 2's `previewsForTexts` lands.
 * `lookupCached`'s `last_access` touch is a WAL write on the one shared
 * connection that also serves WebSocket fan-out and IRC sockets; firing it per
 * row of a 500-row resume snapshot is precisely the shape of the event-loop
 * starvation `SNAPSHOT_SLOW_MS` exists to catch.
 *
 * ⚠ Skipping the touch costs nothing in eviction accuracy, because minting is not
 * reading: the browser fetches the object from the CDN and the cell never learns
 * it happened. `last_access` is meaningful for `local`, which serves every byte
 * itself, and is inherently approximate for `s3`, whose retention is a bucket
 * lifecycle rule rather than an LRU.
 */
export function peekCached(key: string): CacheEntry | null {
  const row = SELECT_ENTRY.get(key);
  if (!row) return null;
  return {
    key: row.cache_key,
    backend: row.backend,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

/** Record a stored object. Upsert, because two readers can race the same miss. */
export function recordCached(entry: Omit<CacheEntry, 'createdAt'>): void {
  UPSERT_ENTRY.run(entry.key, entry.backend, entry.contentType, entry.size);
}

/** Drop the row for an object that is gone, or that we failed to store. */
export function forget(key: string): void {
  DELETE_ENTRY.run(key);
}

/** Total bytes attributed to a backend. The number an eviction pass works against. */
export function cachedBytes(backend: string): number {
  const row = SUM_BYTES.get(backend);
  return row?.total ?? 0;
}

/**
 * The coldest entries for a backend, oldest first.
 *
 * ⚠ Returns candidates rather than deleting them, because the row and the bytes
 * live in different places and the bytes are the half that can fail. The caller
 * unlinks first and calls `forget` only for what it actually removed — the other
 * order leaves a file nothing remembers, which is a leak no later pass can find.
 */
export function coldestCached(backend: string, limit: number): CacheEntry[] {
  return COLDEST.all(backend, limit).map((row) => ({
    key: row.cache_key,
    backend: row.backend,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  }));
}

/**
 * Entries stored before `cutoffIso`, oldest first.
 *
 * ⚠ Candidates rather than a DELETE, for the same reason `coldestCached` is: the
 * row and the bytes live in different places and the caller has to remove the
 * bytes first. A blanket `DELETE ... WHERE created_at < ?` would be one statement
 * and would orphan every `local` file it forgot.
 *
 * ⚠ ISO strings compare correctly as TEXT — that is why `created_at` is stored
 * ISO-with-Z rather than SQLite's `datetime('now')`. See the schema note.
 */
export function expiredCached(backend: string, cutoffIso: string, limit: number): CacheEntry[] {
  return EXPIRED.all(backend, cutoffIso, limit).map((row) => ({
    key: row.cache_key,
    backend: row.backend,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  }));
}

/**
 * Rows belonging to a backend that is no longer the configured one.
 *
 * ⚠ An operator who switches `local` → `s3` leaves every old row behind, and
 * nothing else revisits them: `lookup` forgets a foreign row only if a request
 * happens to ask for that exact key, which for a mode nobody is using never
 * happens. Left alone the table keeps rows forever for bytes that are unreachable
 * by construction.
 */
export function foreignCached(backend: string, limit: number): CacheEntry[] {
  return FOREIGN.all(backend, limit).map((row) => ({
    key: row.cache_key,
    backend: row.backend,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  }));
}

/** Test seam, and the answer to "did anything actually get stored". */
export function countCached(): number {
  const row = COUNT_ALL.get();
  return row?.n ?? 0;
}
