// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// EXPLAIN QUERY PLAN assertions for the id-keyed message paths. The unread
// count being INDEX-ONLY is a load-bearing property (#469: reaching the count
// cap used to mean thousands of scattered rowid lookups per buffer per connect
// snapshot) — these tests pin the plan itself so an index or predicate edit
// that silently de-covers the query fails CI instead of shipping a
// spinning-disk regression.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-eqp-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

function plan(sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(' | ');
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('unread-count path', () => {
  it('uses the covering per-buffer index (countUnreadRows shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM (
         SELECT 1 FROM messages
         WHERE buffer_id = 1 AND id > 0
           AND type IN ('message','action','notice')
           AND from_ignored = 0
         ORDER BY id DESC
         LIMIT 1000
       )`,
    );
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('page and probe paths', () => {
  it('the backlog page walks the per-buffer index (listMessages shape)', () => {
    const detail = plan(`SELECT * FROM messages WHERE buffer_id = 1 ORDER BY id DESC LIMIT 50`);
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });

  it('the edge probe is an index seek (hasOlderThan shape)', () => {
    const detail = plan(`SELECT 1 FROM messages WHERE buffer_id = 1 AND id < 5 LIMIT 1`);
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('highlight-count path', () => {
  it('uses the partial matched index (countHighlightsNewer shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM messages
       WHERE buffer_id = 1 AND id > 0
         AND matched_rule_id IS NOT NULL
         AND from_ignored = 0
         AND notable = 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_matched_buf/);
  });
});
