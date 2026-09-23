// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The credentials an IRC client logs in to the bouncer with: the account
// password or a read-write API token. The bouncer checks them at SASL or PASS,
// and the FILEHOST upload route checks the same ones, because the spec has a
// client authenticate its upload with the credentials of its IRC connection.

import { findUserByUsername, getPasswordHash } from '../db/users.js';
import type { User } from '../db/users.js';
import { verifyPassword, hashPassword } from './password.js';
import { hashToken, findActiveByHash, touchLastUsed } from '../db/apiTokens.js';

// A scrypt hash used ONLY to equalize login latency (see verifyBouncerLogin):
// every auth path runs one scrypt so an unknown/passwordless username can't be
// told apart from a real one by response time. Computed lazily on the first
// login rather than at import, so a disabled bouncer costs no startup scrypt.
let timingDummyHash: string | null = null;
function timingEqualizerHash(): string {
  if (timingDummyHash === null) timingDummyHash = hashPassword('lurker-bouncer-timing-equalizer');
  return timingDummyHash;
}

/** The account a password or read-write API token opens, with the token's id
 *  (null for the password), so revoking the token can close what it opened. */
export function verifyBouncerLogin(
  username: string,
  secret: string,
): { user: User; apiTokenId: number | null } | null {
  // findUserByUsername folds case itself now, so the old explicit
  // lowercase retry (IRC clients routinely lowercase the SASL username) is
  // no longer needed.
  const user = findUserByUsername(username);
  const storedHash = user ? getPasswordHash(user.id) : null;
  // Always run exactly one scrypt (against a dummy hash when the user is
  // unknown or has no password) so login latency can't reveal whether the
  // username exists — verifyPassword(_, null) would otherwise return instantly.
  const passwordOk = verifyPassword(secret, storedHash ?? timingEqualizerHash());
  if (!user) return null;
  if (passwordOk && storedHash) return { user, apiTokenId: null };
  const token = findActiveByHash(hashToken(secret));
  if (token && token.userId === user.id && token.scope === 'read-write') {
    touchLastUsed(token.id);
    return { user, apiTokenId: token.id };
  }
  return null;
}
