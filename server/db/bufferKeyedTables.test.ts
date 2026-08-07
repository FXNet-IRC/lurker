// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Drift test for the buffer-scoped table registry. Introspects the LIVE
// migrated schema in both directions, so the registry cannot quietly diverge
// from reality — its predecessor (a hand-copied list inside foldBufferCase)
// did exactly that, and by schema 16 named two tables that had been dropped.
//
// The registry, not this file, is where a decision gets recorded; this file is
// what makes an unrecorded decision fail CI.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  BUFFER_SCOPED_TABLES,
  PENDING_BUFFER_TABLES,
  BUFFER_TARGET_COLUMN_NAMES,
  NON_BUFFER_TARGET_TABLES,
} from './bufferKeyedTables.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-buffer-tables-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
}

function tableNames(): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columns(table: string): ColumnRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('registry completeness (schema → registry)', () => {
  it('declares every live table with a buffer-target-shaped column', () => {
    const declared = new Set(BUFFER_SCOPED_TABLES.map((t) => t.table));
    const exempt = new Set(NON_BUFFER_TARGET_TABLES);

    const undeclared: string[] = [];
    for (const table of tableNames()) {
      if (declared.has(table) || exempt.has(table)) continue;
      const hit = columns(table).find((c) => BUFFER_TARGET_COLUMN_NAMES.includes(c.name));
      if (hit) undeclared.push(`${table}.${hit.name}`);
      // Independently: any table that grows a buffer_id must be declared too —
      // an id-keyed table that isn't in the registry would be invisible to the
      // satellite-rebuild worklist and the export contract.
      const idHit = columns(table).find((c) => c.name === 'buffer_id');
      if (idHit && !hit) undeclared.push(`${table}.buffer_id`);
    }

    // A new buffer-scoped table must be declared in BUFFER_SCOPED_TABLES —
    // keyed by buffer_id, or 'pending' with an explicit note. If the column
    // only looks like a buffer target, add the table to
    // NON_BUFFER_TARGET_TABLES with a reason.
    expect(undeclared).toEqual([]);
  });
});

describe('registry accuracy (registry → schema)', () => {
  it('declares no table or column the live schema lacks', () => {
    const live = new Set(tableNames());
    const missing: string[] = [];
    for (const t of BUFFER_SCOPED_TABLES) {
      if (!live.has(t.table)) {
        missing.push(t.table);
        continue;
      }
      const names = new Set(columns(t.table).map((c) => c.name));
      const expected = [t.targetColumn, ...t.scope].filter(Boolean) as string[];
      if (t.status === 'buffer_id') expected.push('buffer_id');
      for (const col of expected) {
        if (!names.has(col)) missing.push(`${t.table}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps 'pending' entries honest: their name column is still the key", () => {
    // When a rebuild flips a table to buffer_id, its registry entry must flip
    // in the same PR — a 'pending' table that has grown a buffer_id (or lost
    // its name column) is an undeclared migration.
    const wrong: string[] = [];
    for (const t of PENDING_BUFFER_TABLES) {
      const names = new Set(columns(t.table).map((c) => c.name));
      if (names.has('buffer_id')) wrong.push(`${t.table}: has buffer_id but declared pending`);
      if (t.targetColumn && !names.has(t.targetColumn)) {
        wrong.push(`${t.table}: declared pending but ${t.targetColumn} is gone`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps 'wire-context' tables on the IRC side of the boundary", () => {
    // These key on protocol context strings (e2e `@ident@host` pseudochannels,
    // peer-supplied channel names), which only sometimes coincide with buffer
    // names — a buffer_id here would be a category error. If one legitimately
    // needs normalizing someday, that is a design decision to record in the
    // registry, not a column to slip in.
    const wrong: string[] = [];
    for (const t of BUFFER_SCOPED_TABLES.filter((x) => x.status === 'wire-context')) {
      const names = new Set(columns(t.table).map((c) => c.name));
      if (names.has('buffer_id')) wrong.push(`${t.table}: wire-context table grew a buffer_id`);
      if (t.targetColumn && !names.has(t.targetColumn)) {
        wrong.push(`${t.table}: context column ${t.targetColumn} is gone`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the rebuilt view-state tables carry no name column at all', () => {
    // The whole point of v18: for these, the name lives in `buffers` alone.
    const wrong: string[] = [];
    for (const t of BUFFER_SCOPED_TABLES.filter((x) => x.status === 'buffer_id' && !x.tombstone)) {
      const names = new Set(columns(t.table).map((c) => c.name));
      for (const shaped of BUFFER_TARGET_COLUMN_NAMES) {
        if (names.has(shaped)) wrong.push(`${t.table}.${shaped}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('has no duplicate table entries', () => {
    const names = BUFFER_SCOPED_TABLES.map((t) => t.table);
    expect(names.length).toBe(new Set(names).size);
  });

  it('marks exactly the COLLATE NOCASE target columns as caseInsensitive', () => {
    const mismatches: string[] = [];
    for (const t of BUFFER_SCOPED_TABLES) {
      if (!t.targetColumn) continue;
      const ddl = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(t.table) as { sql: string } | undefined
      )?.sql;
      if (!ddl) continue;
      const decl = new RegExp(`\\b${t.targetColumn}\\b[^,]*`, 'i').exec(ddl)?.[0] ?? '';
      const nocase = /COLLATE\s+NOCASE/i.test(decl);
      if (nocase !== !!t.caseInsensitive) {
        mismatches.push(
          `${t.table}.${t.targetColumn}: schema=${nocase} declared=${!!t.caseInsensitive}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('the buffer_id foreign key', () => {
  it('messages.buffer_id references buffers(id) ON DELETE CASCADE', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(messages)`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const fk = fks.find((f) => f.from === 'buffer_id');
    expect(fk).toBeTruthy();
    expect(fk?.table).toBe('buffers');
    expect(fk?.to).toBe('id');
    expect(fk?.on_delete).toBe('CASCADE');
  });

  it('the id-keyed message indexes exist and the name-keyed generation is gone', () => {
    const indexes = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(indexes.has('idx_messages_buf_unread')).toBe(true);
    expect(indexes.has('idx_messages_matched_buf')).toBe(true);
    expect(indexes.has('idx_messages_unread')).toBe(false);
    expect(indexes.has('idx_messages_matched')).toBe(false);
    expect(indexes.has('idx_messages_buffer')).toBe(false);
  });
});

describe('the retired tables really are retired', () => {
  it('does not create channels or closed_buffers on a fresh install', () => {
    const live = new Set(tableNames());
    expect(live.has('channels')).toBe(false);
    expect(live.has('closed_buffers')).toBe(false);
  });
});

describe('the dead muted column stays dead', () => {
  it('is not resurrected by any every-boot ensureColumn', () => {
    // The v18 rebuild dropped channel_notify_settings.muted, but an ungated
    // ensureColumn used to RE-ADD it on the next boot — which re-armed the
    // muted→ignore fold against a table whose network_id no longer exists
    // (a warn on every startup). This pins the gate.
    const cols = (
      db.prepare(`PRAGMA table_info(channel_notify_settings)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).not.toContain('muted');
  });
});
