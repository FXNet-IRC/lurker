// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Database, Statement } from 'better-sqlite3';
import { foldTargetWith, normalizeCasemapping } from './casemapping.js';

// The v17 normalization bodies: mint the buffers rows that message history
// implies, then stamp messages.buffer_id from them. Exported (and handed the
// db) rather than inlined in index.ts for three reasons: index.ts calls them
// at module load mid-evaluation (importing it back would be a cycle — same
// pattern as foldBufferCase/seedUploaderConfig), the import path reuses them
// to normalize v1 archives, and the kill/resume behavior is unit-testable.
//
// Everything here is idempotent and re-runnable: mints are insert-if-absent,
// the backfill only touches `buffer_id IS NULL` rows, and progress persists in
// app_meta inside each chunk's transaction. A watchdog kill mid-run loses at
// most one chunk and the next boot resumes where it left off — the restart
// loop documented on the idx_messages_unread build (a one-shot, non-resumable
// stall) structurally cannot happen here.
//
// Folding: the set-based SQL passes call a registered custom function that IS
// the legacy JS fold (toLowerCase) — SQLite's own lower() is ASCII-only and
// `#Ärger` folds differently under the two, exactly the class of bug #707
// catalogues. That's correct for the version-gated migration bodies, which
// run before any network can have declared a CASEMAPPING. The JS-side mints
// are different: they ALSO run on straggler-retry boots and on archive
// import, where a network may carry a declared mapping — so they fold
// per-network via foldForNetworkFn below (reading through the handed db;
// importing buffers.ts here would cycle back through index.ts
// mid-evaluation). Probing with the legacy fold there misses a refolded row
// and mints an unreachable zombie twin beside it.

const FOLD_FN = 'lurker_fold_target';

export function registerFoldFunction(db: Database): void {
  // Registering the same name twice replaces the implementation — harmless —
  // but wrap anyway so a driver that objects can't turn boot into a crash.
  try {
    db.function(FOLD_FN, { deterministic: true }, (target) =>
      typeof target === 'string' ? target.toLowerCase() : null,
    );
  } catch {
    /* already registered */
  }
}

/**
 * Mint the `:system:` row for every user and the `:server:<netId>` row for
 * every network. These buffers have always existed behaviorally (real
 * buffer_reads rows, real `:server:` message rows, synthesized by wsHub's
 * walk) — the kind enum reserved 'server'/'system' for the day they became
 * real rows, and buffer_id is that day: leaving them rowless would mean the
 * unread path keeps a (network_id, target) index forever just for sentinels.
 *
 * state 'open': they are permanent, uncloseable fixtures (buffers.ts guards
 * close/delete against these kinds).
 */
export function mintSentinelBuffers(db: Database): void {
  // `WHERE true` disambiguates the upsert clause — without it SQLite parses
  // the ON of ON CONFLICT as a join constraint and errors "near DO".
  db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     SELECT u.id, NULL, ':system:', ':system:', 'system', 'open', 0, NULL FROM users u WHERE true
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     SELECT n.user_id, n.id, ':server:' || n.id, ':server:' || n.id, 'server', 'open', 0, NULL
     FROM networks n WHERE true
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  ).run();
}

/**
 * Mint a CLOSED buffers row for every distinct message target that lacks one.
 *
 * The v16 migration derived the registry FROM history, so on a healthy DB this
 * mints nothing. It exists because the alternative on a damaged or hand-edited
 * DB is worse in both directions: dropping the rows loses user data, and
 * leaving them unmatched leaves messages.buffer_id NULL — invisible history.
 * Closed means garbage never surfaces in a sidebar; genuinely-live targets get
 * reopened by their next message through the ordinary reducer.
 *
 * Folding is done in JS (foldTarget parity — see module header), so the
 * distinct targets are materialized and folded here rather than inserted
 * set-based. The distinct list is O(buffers), not O(messages), in size; the
 * scan to produce it is one index-only pass. Materialized with .all() —
 * iterating a live cursor while writing on the shared connection is the
 * documented crash class (AGENTS.md).
 */
/** Per-network fold for the JS-side mints (see the module header). Returns a
 *  closure over a per-run mapping cache; NULL network (app-scoped) and
 *  undeclared networks use the legacy fold. On a pre-#707 schema (a mid-
 *  migration fixture where networks.casemapping doesn't exist yet) no mapping
 *  can have been declared, so the legacy fold is exact by definition. */
function foldForNetworkFn(db: Database): (networkId: number | null, target: string) => string {
  let stmt: Statement | null;
  try {
    stmt = db.prepare(`SELECT casemapping FROM networks WHERE id = ?`);
  } catch {
    stmt = null;
  }
  const cache = new Map<number, string | null>();
  return (networkId, target) => {
    if (networkId == null || !stmt) return target.toLowerCase();
    let raw = cache.get(networkId);
    if (raw === undefined) {
      raw =
        (stmt.get(networkId) as { casemapping: string | null } | undefined)?.casemapping ?? null;
      cache.set(networkId, raw);
    }
    return foldTargetWith(normalizeCasemapping(raw) ?? null, target);
  };
}

export function mintOrphanBuffersFromMessages(db: Database): number {
  const distinct = db
    .prepare(`SELECT DISTINCT network_id AS networkId, target FROM messages`)
    .all() as Array<{ networkId: number; target: string }>;
  if (distinct.length === 0) return 0;

  const userByNetwork = db.prepare(`SELECT user_id AS userId FROM networks WHERE id = ?`);
  const exists = db.prepare(
    `SELECT 1 FROM buffers
     WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     VALUES (?, ?, ?, ?, ?, 'closed', 0, NULL)
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  );

  const foldFor = foldForNetworkFn(db);
  let minted = 0;
  for (const { networkId, target } of distinct) {
    const owner = userByNetwork.get(networkId) as { userId: number } | undefined;
    if (!owner) continue; // orphaned network row; the FK would reject the mint
    // ':'-prefixed strays (a sentinel casing variant, a ':server:<foreignId>'
    // from a legacy import) are NOT minted: a ':' row the walk skips and
    // nothing can open would be a hidden buffer stranding its history. The
    // backfill maps these onto the network's canonical `:server:` sentinel
    // instead — the same coalescing the live insert path applies — so
    // imported server-console history becomes reachable rather than hidden.
    if (target.startsWith(':')) continue;
    const folded = foldFor(networkId, target);
    if (exists.get(owner.userId, networkId, folded)) continue;
    const kind = '#&+!'.includes(target[0] ?? '') ? 'channel' : 'dm';
    minted += insert.run(owner.userId, networkId, target, folded, kind).changes;
  }
  return minted;
}

const CURSOR_KEY = 'messages_bufferid_cursor';
const DONE_KEY = 'messages_bufferid_done';

/** Default rows per chunk. ~25k rows keeps each transaction (and the WAL it
 *  appends) small enough that Litestream replicates increments instead of one
 *  giant gulp, while the whole 2M-row reference account still completes in
 *  well under a hundred transactions. */
export const BACKFILL_CHUNK_ROWS = 25_000;

export interface BackfillResult {
  /** Rows actually stamped by this run (not counting already-done rows). */
  updated: number;
  /** True when the done-flag is set (no NULL buffer_id remains). */
  complete: boolean;
}

/**
 * Stamp messages.buffer_id in resumable, rowid-range chunks.
 *
 * Each chunk is its own IMMEDIATE transaction with the progress cursor written
 * inside it, so any kill leaves a committed prefix and the next call resumes
 * from the cursor. Chunking across transactions would be unsafe on the shared
 * connection if the server were running (another write would join an open
 * transaction) — it is safe here solely because this runs synchronously at
 * module load, before anything else can touch the database. Do not call it
 * from a live server without re-deriving that argument.
 *
 * The subquery's fold uses the registered JS-parity function (module header),
 * and its IFNULL form matches idx_buffers_key so each row costs one index
 * seek. Rows whose target resolves to no buffers row stay NULL — the caller
 * loops mint→backfill and warns if anything survives both.
 */
export function backfillMessagesBufferId(
  db: Database,
  {
    chunk = BACKFILL_CHUNK_ROWS,
    abortAfterChunks,
  }: { chunk?: number; abortAfterChunks?: number } = {},
): BackfillResult {
  registerFoldFunction(db);
  if (getMeta(db, DONE_KEY)) return { updated: 0, complete: true };

  const maxId =
    (db.prepare(`SELECT MAX(id) AS m FROM messages`).get() as { m: number | null }).m ?? 0;
  let cursor = Number(getMeta(db, CURSOR_KEY) ?? 0);
  let updated = 0;
  let chunks = 0;

  // COALESCE second arm: any ':'-prefixed target that doesn't resolve on its
  // own name (a ':server:<foreignId>' stray from a legacy import) lands on the
  // network's canonical `:server:` sentinel — the same coalescing the live
  // insert path applies, and the reason the orphan mint skips ':' targets
  // (a minted ':' row would be hidden from the walk and unopenable, stranding
  // its history). The canonical target ':server:<netId>' resolves via the
  // FIRST arm, since the sentinel row's own folded name matches it.
  const updateStmt = db.prepare(
    `UPDATE messages SET buffer_id = COALESCE(
       (SELECT b.id FROM buffers b
        WHERE b.user_id = (SELECT n.user_id FROM networks n WHERE n.id = messages.network_id)
          AND IFNULL(b.network_id, 0) = messages.network_id
          AND b.target_folded = ${FOLD_FN}(messages.target)),
       CASE WHEN messages.target LIKE ':%' THEN
         (SELECT b.id FROM buffers b
          WHERE b.network_id = messages.network_id AND b.kind = 'server')
       END
     )
     WHERE id > ? AND id <= ? AND buffer_id IS NULL`,
  );

  const step = db.transaction((lo: number, hi: number) => {
    const n = updateStmt.run(lo, hi).changes;
    setMeta(db, CURSOR_KEY, String(hi));
    return n;
  });

  while (cursor < maxId) {
    const hi = Math.min(cursor + chunk, maxId);
    updated += step.immediate(cursor, hi);
    cursor = hi;
    chunks += 1;
    if (abortAfterChunks !== undefined && chunks >= abortAfterChunks) {
      return { updated, complete: false };
    }
  }

  // The cursor only moves forward, so rows a first pass could not resolve
  // (no buffers row yet) are behind it by the time a re-mint fixes the cause.
  // One full-range sweep picks them up: it touches only `buffer_id IS NULL`
  // rows, which at this point is the (near-empty) straggler set.
  if (db.prepare(`SELECT 1 FROM messages WHERE buffer_id IS NULL LIMIT 1`).get()) {
    const sweep = db.transaction(() => updateStmt.run(0, maxId).changes);
    updated += sweep.immediate();
  }

  const straggler = db.prepare(`SELECT 1 FROM messages WHERE buffer_id IS NULL LIMIT 1`).get();
  if (straggler) return { updated, complete: false };
  const finish = db.transaction(() => {
    setMeta(db, DONE_KEY, '1');
    setMeta(db, CURSOR_KEY, String(maxId));
  });
  finish.immediate();
  return { updated, complete: true };
}

/** Is the messages backfill recorded as complete? (Gates the index swap.) */
export function messagesBackfillDone(db: Database): boolean {
  return !!getMeta(db, DONE_KEY);
}

/**
 * The whole v17 data pass: sentinels, orphans, backfill — looped once more if
 * stragglers survive (a target minted between fold rules can leave a first
 * pass short; the second pass resolves against the fresh mints). Never throws
 * on stragglers: a warn plus an unset done-flag retries next boot, which beats
 * a crash-looping cell (the house rule about throwing at module load).
 */
export function normalizeMessagesBufferIds(
  db: Database,
  opts: { chunk?: number } = {},
): BackfillResult {
  registerFoldFunction(db);
  let result: BackfillResult = { updated: 0, complete: messagesBackfillDone(db) };
  if (result.complete) return result;
  for (let pass = 0; pass < 2; pass += 1) {
    mintSentinelBuffers(db);
    mintOrphanBuffersFromMessages(db);
    result = backfillMessagesBufferId(db, opts);
    if (result.complete) return result;
  }
  console.warn(
    '[db] messages.buffer_id backfill left unresolved rows; will retry next boot. ' +
      'If this repeats, some message targets cannot be minted (orphaned network rows?).',
  );
  return result;
}

// --- v18: satellite rebuild -------------------------------------------------

/** The resolve expression shared by every satellite rebuild's SELECT: the
 *  ordinary folded lookup, then (for ':'-prefixed targets only) the row's
 *  sentinel — the user's system console when the row is app-scoped, the
 *  network's server console otherwise. Same coalescing as the v17 messages
 *  backfill. `r` is the source-table alias; requires the fold function to be
 *  registered and sentinels minted. */
function satelliteResolveSql(r: string): string {
  return `COALESCE(
    (SELECT b.id FROM buffers b
      WHERE b.user_id = ${r}.user_id
        AND IFNULL(b.network_id, 0) = IFNULL(${r}.network_id, 0)
        AND b.target_folded = ${FOLD_FN}(${r}.target)),
    CASE WHEN ${r}.target LIKE ':%' THEN
      CASE WHEN ${r}.network_id IS NULL THEN
        (SELECT bs.id FROM buffers bs WHERE bs.user_id = ${r}.user_id AND bs.kind = 'system')
      ELSE
        (SELECT bn.id FROM buffers bn WHERE bn.network_id = ${r}.network_id AND bn.kind = 'server')
      END
    END
  )`;
}

/**
 * Mint CLOSED buffers rows for satellite targets that resolve to nothing —
 * same policy and shape as the messages orphan mint: user view-state for a
 * buffer the registry forgot must not be dropped when a hidden row preserves
 * it. ':'-prefixed targets are skipped (they coalesce onto sentinels).
 */
export function mintOrphanBuffersFromSatellites(db: Database, tables: readonly string[]): number {
  const insert = db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
     VALUES (?, ?, ?, ?, ?, 'closed', 0, NULL)
     ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING`,
  );
  const networkExists = db.prepare(`SELECT 1 FROM networks WHERE id = ?`);
  const foldFor = foldForNetworkFn(db);
  let minted = 0;
  for (const table of tables) {
    const rows = db
      .prepare(
        `SELECT DISTINCT r.user_id AS userId, r.network_id AS networkId, r.target AS target
         FROM ${table} r
         WHERE ${satelliteResolveSql('r')} IS NULL`,
      )
      .all() as Array<{ userId: number; networkId: number | null; target: string }>;
    for (const { userId, networkId, target } of rows) {
      if (target.startsWith(':')) continue;
      if (networkId != null && !networkExists.get(networkId)) continue; // FK would reject
      const kind = '#&+!'.includes(target[0] ?? '') ? 'channel' : 'dm';
      minted += insert.run(userId, networkId, target, foldFor(networkId, target), kind).changes;
    }
  }
  return minted;
}

/**
 * The v18 cutover body: rebuild the six view-state satellites onto
 * (user_id, buffer_id) keys, dropping their name columns. One synchronous
 * transaction — the tables are small (thousands of rows, not millions), so
 * atomic-and-quick is the right shape; the caller wraps it `.immediate()`
 * with foreign_keys OFF (the established rebuild pattern).
 *
 * Case-twin merges: the old binary-collated PKs let `#Chan` and `#chan`
 * coexist; both resolve to one buffer_id now, so each table declares a merge
 * policy — furthest read pointer / max cleared marker (mirrors what
 * foldBufferCase did), earliest pin slot, latest draft, MAX for booleans.
 * Where a policy needs "the rest of that row's columns", the SELECT uses
 * SQLite's documented single-aggregate bare-column rule (min/max queries pull
 * bare columns from the winning row — same device as listSpeakers).
 *
 * Rows whose target resolves to nothing even after the orphan mint (an
 * orphaned network id, garbage) are DROPPED — they are view-state pointers
 * with no buffer to point at — and the count is logged, never silent.
 */
export function rebuildSatellitesToBufferId(db: Database): void {
  registerFoldFunction(db);

  const dropped = (table: string): number =>
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} r WHERE ${satelliteResolveSql('r')} IS NULL`)
        .get() as { n: number }
    ).n;
  for (const table of [
    'buffer_reads',
    'input_history',
    'pinned_buffers',
    'nicklist_collapsed',
    'channel_notify_settings',
    'user_drafts',
  ]) {
    const n = dropped(table);
    if (n > 0) {
      console.warn(`[db] v18: dropping ${n} ${table} row(s) whose buffer cannot be resolved`);
    }
  }

  // buffer_reads — merge policy: furthest read pointer, max cleared marker.
  db.exec(`
    CREATE TABLE buffer_reads_new (
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_before_message_id INTEGER,
      cleared_at TEXT,
      PRIMARY KEY (user_id, buffer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE
    );
  `);
  // cleared_at must ride with the row that WINS the boundary merge — two
  // independent MAX()es could pair one twin's boundary with the other's
  // timestamp, an impossible state /clear-undo would then mis-render (the old
  // fold's CASE did exactly this pairing). FIRST_VALUE over the boundary
  // ordering stamps every row in the group with the winner's cleared_at, and
  // the outer MAX() then reads that constant. A cleared_at never exists
  // without its boundary (setClearedState writes or nulls them together), so
  // the no-marker group stays NULL.
  db.exec(`
    INSERT INTO buffer_reads_new
      (user_id, buffer_id, last_read_message_id, updated_at, cleared_before_message_id, cleared_at)
    SELECT user_id, bid, MAX(last_read_message_id), MAX(updated_at),
           MAX(cleared_before_message_id), MAX(win_cleared_at)
    FROM (
      SELECT *, FIRST_VALUE(cleared_at) OVER (
        PARTITION BY user_id, bid
        ORDER BY COALESCE(cleared_before_message_id, 0) DESC
      ) AS win_cleared_at
      FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM buffer_reads r)
      WHERE bid IS NOT NULL
    )
    GROUP BY user_id, bid
  `);
  db.exec(`DROP TABLE buffer_reads`);
  db.exec(`ALTER TABLE buffer_reads_new RENAME TO buffer_reads`);

  // input_history — ids preserved (ordering key + export pk); no dedupe
  // needed, the surrogate id was the PK.
  db.exec(`
    CREATE TABLE input_history_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT INTO input_history_new (id, user_id, buffer_id, text, created_at)
    SELECT id, user_id, bid, text, created_at
    FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM input_history r)
    WHERE bid IS NOT NULL
  `);
  db.exec(`DROP TABLE input_history`);
  db.exec(`ALTER TABLE input_history_new RENAME TO input_history`);
  db.exec(`CREATE INDEX idx_input_history_buffer
           ON input_history(user_id, buffer_id, id DESC)`);

  // pinned_buffers — earliest slot wins for a case twin (single MIN aggregate;
  // network_id/created_at ride from that row), then positions re-densified per
  // (user, network) since a merge can leave holes.
  db.exec(`
    CREATE TABLE pinned_buffers_new (
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, buffer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT INTO pinned_buffers_new (user_id, buffer_id, network_id, position, created_at)
    SELECT user_id, bid, network_id, MIN(position), created_at
    FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM pinned_buffers r)
    WHERE bid IS NOT NULL
    GROUP BY user_id, bid
  `);
  db.exec(`DROP TABLE pinned_buffers`);
  db.exec(`ALTER TABLE pinned_buffers_new RENAME TO pinned_buffers`);
  db.exec(`
    UPDATE pinned_buffers SET position = (
      SELECT rn - 1 FROM (
        SELECT p2.buffer_id AS bid2,
               ROW_NUMBER() OVER (
                 PARTITION BY p2.user_id, p2.network_id ORDER BY p2.position, p2.buffer_id
               ) AS rn
        FROM pinned_buffers p2
        WHERE p2.user_id = pinned_buffers.user_id AND p2.network_id = pinned_buffers.network_id
      ) WHERE bid2 = pinned_buffers.buffer_id
    )
  `);
  db.exec(`CREATE INDEX idx_pinned_buffers_user_net
           ON pinned_buffers(user_id, network_id, position)`);

  // nicklist_collapsed — MAX(collapsed): if any case twin was collapsed, stay
  // collapsed.
  db.exec(`
    CREATE TABLE nicklist_collapsed_new (
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, buffer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT INTO nicklist_collapsed_new (user_id, buffer_id, collapsed)
    SELECT user_id, bid, MAX(collapsed)
    FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM nicklist_collapsed r)
    WHERE bid IS NOT NULL
    GROUP BY user_id, bid
  `);
  db.exec(`DROP TABLE nicklist_collapsed`);
  db.exec(`ALTER TABLE nicklist_collapsed_new RENAME TO nicklist_collapsed`);

  // channel_notify_settings — MAX(notify_always); the dead `muted` column
  // (written 0 since the /ignore unification, #359) dies here.
  db.exec(`
    CREATE TABLE channel_notify_settings_new (
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      notify_always INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, buffer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT INTO channel_notify_settings_new (user_id, buffer_id, notify_always, updated_at)
    SELECT user_id, bid, MAX(notify_always), updated_at
    FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM channel_notify_settings r)
    WHERE bid IS NOT NULL
    GROUP BY user_id, bid
  `);
  db.exec(`DROP TABLE channel_notify_settings`);
  db.exec(`ALTER TABLE channel_notify_settings_new RENAME TO channel_notify_settings`);

  // user_drafts — the LATEST draft wins (single MAX(updated_at); body rides
  // from that row).
  db.exec(`
    CREATE TABLE user_drafts_new (
      user_id INTEGER NOT NULL,
      buffer_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, buffer_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (buffer_id) REFERENCES buffers(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT INTO user_drafts_new (user_id, buffer_id, body, updated_at)
    SELECT user_id, bid, body, MAX(updated_at)
    FROM (SELECT r.*, ${satelliteResolveSql('r')} AS bid FROM user_drafts r)
    WHERE bid IS NOT NULL
    GROUP BY user_id, bid
  `);
  db.exec(`DROP TABLE user_drafts`);
  db.exec(`ALTER TABLE user_drafts_new RENAME TO user_drafts`);
}

function getMeta(db: Database, key: string): string | undefined {
  return (
    db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined
  )?.value;
}

function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
