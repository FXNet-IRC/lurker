// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage attribution for the admin Storage pane
// (lurker-dev/RETENTION_PLAN.md §3.4). Lives in db/ — this is the one place
// that walks the messages→networks→users ownership chain for accounting, and
// a schema migration grepping server/db must find it.
//
// The message counts are CHUNKED: keyset pages over idx_messages_net
// (index-only) with a setImmediate yield between pages, because the total is
// O(every stored row) and one synchronous statement over a large instance
// would stall the shared connection for seconds — the snapshot-starvation
// class this codebase has an incident scar from. Each synchronous slice is
// bounded by PAGE_ROWS regardless of instance size.

import db from './index.js';

const PAGE_ROWS = 50_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const pageStmt = db.prepare(`
  SELECT id FROM messages
   WHERE network_id = ? AND id > ?
   ORDER BY id ASC LIMIT ?
`);

async function countNetworkRows(networkId: number): Promise<number> {
  let total = 0;
  let afterId = 0;
  for (;;) {
    const page = pageStmt.all(networkId, afterId, PAGE_ROWS) as Array<{ id: number }>;
    total += page.length;
    if (page.length < PAGE_ROWS) return total;
    afterId = page[page.length - 1].id;
    await yieldToLoop();
  }
}

export interface UserStorageRow {
  id: number;
  username: string;
  messageRows: number;
  buffers: number;
}

export interface StorageAttribution {
  users: UserStorageRow[];
  totalMessageRows: number;
}

export async function collectStorageAttribution(): Promise<StorageAttribution> {
  const users = db.prepare(`SELECT id, username FROM users ORDER BY id`).all() as Array<{
    id: number;
    username: string;
  }>;
  const networks = db.prepare(`SELECT id, user_id AS userId FROM networks`).all() as Array<{
    id: number;
    userId: number;
  }>;
  const buffersByUser = new Map<number, number>(
    (
      db
        .prepare(`SELECT user_id AS userId, COUNT(*) AS n FROM buffers GROUP BY user_id`)
        .all() as Array<{ userId: number; n: number }>
    ).map((r) => [r.userId, r.n]),
  );

  const rowsByUser = new Map<number, number>();
  let totalMessageRows = 0;
  for (const net of networks) {
    const n = await countNetworkRows(net.id);
    totalMessageRows += n;
    rowsByUser.set(net.userId, (rowsByUser.get(net.userId) ?? 0) + n);
    await yieldToLoop();
  }

  return {
    users: users
      .map((u) => ({
        id: u.id,
        username: u.username,
        messageRows: rowsByUser.get(u.id) ?? 0,
        buffers: buffersByUser.get(u.id) ?? 0,
      }))
      .sort((a, b) => b.messageRows - a.messageRows),
    totalMessageRows,
  };
}

/** page_size × freelist_count — freed pages new writes reuse before the file
 *  grows (retention's deletes land here; no VACUUM runs online, by design). */
export function reclaimableBytes(): number {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const freelist = db.pragma('freelist_count', { simple: true }) as number;
  return pageSize * freelist;
}
