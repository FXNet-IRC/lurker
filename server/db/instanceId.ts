// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A stable identity for THIS Lurker database.
//
// Engine connection ids are `<instance>:<userId>:<networkId>`, and userId and
// networkId are rowids — unique in one database and meaningless outside it. Two
// Lurker instances pointed at one engine would otherwise both mint `1:1` for
// unrelated people, and the engine's dial check cannot tell them apart because
// two users on the same popular network dial the identical host/port/tls. That
// is how IRCCloud exposed logs across accounts in July 2020: two connection
// servers issuing ids in one id space.
//
// It lives in the DATABASE, not in an env var or a file beside it, because the
// thing it namespaces IS the database's rowid sequence. Restore this database
// somewhere else and the identity travels with the rows it describes — which is
// what you want: those really are the same connections. Point a second, DIFFERENT
// database at the same engine and it gets its own.
//
// Generated once, then never changes. It is not a secret: it names a namespace,
// it does not protect one (LURKER_ENGINE_SECRET does that).

import { randomBytes } from 'node:crypto';
import db from './index.js';

const KEY = 'engine_instance_id';

let cached: string | null = null;

function read(): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined;
  return row?.value || null;
}

export function instanceId(): string {
  if (cached) return cached;
  const existing = read();
  if (existing) return (cached = existing);
  // DO NOTHING + re-read rather than a bare INSERT: a deploy can briefly run two
  // processes against this file, and both would generate. The one that loses the
  // insert must adopt the winner's value, not its own — two ids for one database
  // is the very collision this exists to prevent.
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(
    KEY,
    randomBytes(16).toString('hex'),
  );
  const settled = read();
  if (!settled) throw new Error('could not establish an instance id');
  return (cached = settled);
}

// Tests only: forget the memoised value so a fresh scratch database is picked up.
export function resetInstanceIdForTests(): void {
  cached = null;
}
