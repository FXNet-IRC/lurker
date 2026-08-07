// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-favseed-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let ensureBuffer: typeof import('./buffers.js').ensureExists;
let closeBuffer: typeof import('./buffers.js').close;
let seedFavoritesFromContacts: typeof import('./contactsToFavoritesSeed.js').seedFavoritesFromContacts;
let listFavoritesForUser: typeof import('./favoriteBuffers.js').listFavoritesForUser;
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

// The v19 migration runs against a DB that still carries the (dropped-from-DDL)
// contacts tables, so the fixture recreates them exactly as an old install
// would have them, seeds representative friends, and runs the seed the way
// index.ts does. Three contact states matter: an existing open DM, a closed
// DM (must reopen), and a never-conversed friend (must mint a buffer).
beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ ensureExists: ensureBuffer, close: closeBuffer } = await import('./buffers.js'));
  ({ seedFavoritesFromContacts } = await import('./contactsToFavoritesSeed.js'));
  ({ listFavoritesForUser } = await import('./favoriteBuffers.js'));
  db = (await import('./index.js')).default;

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      notify_online INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS contact_targets (
      contact_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (contact_id, network_id, nick)
    );
  `);

  user = createUser('favseed-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });

  const addContact = (displayName: string, targets: Array<[number, string, number]>) => {
    const id = Number(
      db
        .prepare(`INSERT INTO contacts (user_id, display_name) VALUES (?, ?)`)
        .run(user!.id, displayName).lastInsertRowid,
    );
    for (const [networkId, nick, isPrimary] of targets) {
      db.prepare(
        `INSERT INTO contact_targets (contact_id, network_id, nick, is_primary) VALUES (?, ?, ?, ?)`,
      ).run(id, networkId, nick, isPrimary);
    }
  };

  // Zoe: open DM already exists (stored casing differs from the target's) —
  // and is PINNED, which the seed must drop (favorite implies unpin; a hidden
  // pin row would be silently demoted by every later subset reorder).
  ensureBuffer(user.id, net!.id, 'zoe');
  const { pinBuffer } = await import('./pinnedBuffers.js');
  pinBuffer(user.id, net!.id, 'zoe');
  addContact('Zoe', [[net!.id, 'ZOE', 1]]);
  // Bram: DM exists but is closed — the seed must reopen it.
  ensureBuffer(user.id, net!.id, 'bram');
  closeBuffer(user.id, net!.id, 'bram');
  addContact('Bram', [[net!.id, 'bram', 1]]);
  // Ada: never conversed — no buffer row at all; the seed must mint one. Also
  // carries a non-primary alt that must NOT become a favorite.
  addContact('Ada', [
    [net!.id, 'ada', 1],
    [net!.id, 'ada_alt', 0],
  ]);
  // Wren: TWO is_primary rows — schema-legal and importable through the old
  // unvalidated archive path, though live setContact never wrote this. Only
  // the first by (network, nick) may become a favorite; duplicating the
  // person in the migrated Friends list is the bug this guards against.
  addContact('Wren', [
    [net!.id, 'wren', 1],
    [net!.id, 'wren2', 1],
  ]);
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('seedFavoritesFromContacts', () => {
  it('converts primaries to favorites (alphabetical), minting/reopening buffers, then drops the tables', () => {
    const seeded = db.transaction(() => seedFavoritesFromContacts(db))();
    expect(seeded).toBe(4);

    // Alphabetical by display name: Ada, Bram, Wren, Zoe. Targets resolve to
    // the stored buffer casing (zoe's row wins over the contact's 'ZOE'), and
    // Wren's duplicate primary contributes ONE favorite (first by nick), not
    // two entries for the same person.
    const favs = listFavoritesForUser(user.id);
    expect(favs.map((f) => f.target)).toEqual(['ada', 'bram', 'wren', 'zoe']);

    // Every favorited buffer is a real, OPEN dm row now.
    for (const f of favs) {
      const row = db.prepare(`SELECT kind, state FROM buffers WHERE id = ?`).get(f.bufferId) as {
        kind: string;
        state: string;
      };
      expect(row).toEqual({ kind: 'dm', state: 'open' });
    }
    // The alt did not surface anywhere.
    const alt = db
      .prepare(
        `SELECT id FROM buffers WHERE user_id = ? AND network_id = ? AND target_folded = 'ada_alt'`,
      )
      .get(user.id, net!.id);
    expect(alt).toBeUndefined();

    // Zoe's pin was dropped along with the favorite grant (favorite⇒unpin).
    const pins = db
      .prepare(`SELECT COUNT(*) AS n FROM pinned_buffers WHERE user_id = ?`)
      .get(user.id) as { n: number };
    expect(pins.n).toBe(0);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contacts','contact_targets')`,
      )
      .all();
    expect(tables).toEqual([]);
  });
});
