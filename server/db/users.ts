// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** User account roles. The first registered user is promoted to 'admin'. */
export type UserRole = 'admin' | 'user';

/** A public row from the `users` table (excludes the password_hash column). */
export interface User {
  id: number;
  username: string;
  role: UserRole;
  created_at: string;
  last_seen_at: string | null;
  // 0 | 1. Paused accounts are disconnected from IRC and barred from
  // reconnecting/sending, but retain read-only access to their history.
  is_paused: number;
  // 0 | 1. A guest is an ephemeral account auto-created for anonymous webchat
  // (FXNet public mode). It behaves like any other user but is reaped once idle,
  // and can be claimed into a permanent account (flips this to 0).
  is_guest: number;
}

export function findUserByUsername(username: string): User | undefined {
  return db
    .prepare(
      'SELECT id, username, role, created_at, last_seen_at, is_paused, is_guest FROM users WHERE username = ?',
    )
    .get(username) as User | undefined;
}

export function findUserById(id: number | bigint): User | undefined {
  return db
    .prepare(
      'SELECT id, username, role, created_at, last_seen_at, is_paused, is_guest FROM users WHERE id = ?',
    )
    .get(id) as User | undefined;
}

export function listUsers(): User[] {
  return db
    .prepare(
      'SELECT id, username, role, created_at, last_seen_at, is_paused, is_guest FROM users ORDER BY id',
    )
    .all() as User[];
}

// Throttled to once per minute via the WHERE clause so a busy client (many
// API calls per second) doesn't write to the row on every request — the row
// is only written when the existing value is missing or older than 60s.
export function touchUserLastSeen(userId: number): void {
  db.prepare(
    `
    UPDATE users
       SET last_seen_at = datetime('now')
     WHERE id = ?
       AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 seconds'))
  `,
  ).run(userId);
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function countAdmins(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number })
    .n;
}

export function createUser(username: string, { role = 'user' }: { role?: UserRole } = {}): User {
  const info = db.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run(username, role);
  const user = findUserById(info.lastInsertRowid);
  if (!user) throw new Error('createUser: row missing immediately after insert');
  return user;
}

// Create an ephemeral guest account (is_guest=1). Role is always 'user'. The
// username is an internal-only handle (e.g. `guest-<rand>`); the IRC-visible nick
// lives on the seeded network row, not here.
export function createGuestUser(username: string): User {
  const info = db
    .prepare(`INSERT INTO users (username, role, is_guest) VALUES (?, 'user', 1)`)
    .run(username);
  const user = findUserById(info.lastInsertRowid);
  if (!user) throw new Error('createGuestUser: row missing immediately after insert');
  return user;
}

// Convert a guest row into a permanent account: claim a real username and flip
// is_guest off. Scoped to is_guest=1 so a normal account can never rename itself
// through this path. Returns false when no guest row matched (already claimed or
// unknown id). The caller sets the credential (password/passkey) separately, on
// the SAME user id, so all settings/networks/history carry over untouched.
export function claimGuestUser(userId: number, username: string): boolean {
  const info = db
    .prepare('UPDATE users SET username = ?, is_guest = 0 WHERE id = ? AND is_guest = 1')
    .run(username, userId);
  return info.changes > 0;
}

// Ids of guest accounts idle for at least `idleMinutes`. Uses last_seen_at when
// set (refreshed on every authed request and at WS upgrade) and falls back to
// created_at so a freshly-created guest that hasn't connected yet still gets a
// full idle window before it can be reaped. The cutoff is computed in SQL so it
// matches the datetime('now') format the columns are written with.
export function listIdleGuestIds(idleMinutes: number): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM users
          WHERE is_guest = 1
            AND COALESCE(last_seen_at, created_at) < datetime('now', ?)`,
      )
      .all(`-${idleMinutes} minutes`) as Array<{ id: number }>
  ).map((r) => r.id);
}

export function getPasswordHash(userId: number): string | null {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string | null }
    | undefined;
  return row ? row.password_hash : null;
}

export function userHasPassword(userId: number): boolean {
  return getPasswordHash(userId) !== null;
}

export function setPasswordHash(userId: number, hash: string | null): boolean {
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  return info.changes > 0;
}

// Flip account access state. Returns false only when no row matched (unknown
// id); an idempotent set to the same value still returns true. The caller owns
// the side effects of a transition — tearing down / re-establishing IRC — since
// this only writes the row.
export function setUserPaused(userId: number, paused: boolean): boolean {
  const info = db
    .prepare('UPDATE users SET is_paused = ? WHERE id = ?')
    .run(paused ? 1 : 0, userId);
  return info.changes > 0;
}

// Hard delete. FKs are ON DELETE CASCADE for sessions / networks / messages /
// settings / etc., so dependent rows vacate on their own.
export function deleteUser(id: number): boolean {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}
