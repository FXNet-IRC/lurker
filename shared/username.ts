// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single source of truth for what a valid account username is. Shared by
// the human signup/auth flows (routes/auth.ts) and the orchestrator's node
// provisioning API (routes/node.ts) so an account created by either path is
// valid everywhere it surfaces — the UI, IRC registration, etc. The charset is
// deliberately conservative (no control characters, no exotic Unicode).
//
// Two rules, not one, because CREATING a name and PROVING you own one are
// different jobs:
//
//   isValidUsername      — the rule for a NEW account. Tightened: no spaces, and
//     uniqueness is enforced case-insensitively by the callers (db/users.ts's
//     usernameTaken). A username is an identity people read off a screen and
//     type at a login prompt; "Bob Smith" vs "bob smith" vs "bobsmith" being
//     three separate accounts is a footgun, not a feature. It also feeds the
//     identd ident (shared/ident.ts), which allows neither spaces nor a case
//     distinction — so a space in a username was already being silently dropped
//     somewhere downstream.
//   isValidLoginUsername — the rule for a name being SUBMITTED at login. A pure
//     shape guard: non-empty, not absurdly long, no charset rule at all. It
//     cannot assume any charset, because the DB may hold names no validator ever
//     saw (see the note on it below). Accounts predating the tightening are
//     grandfathered — they keep their name and keep logging in with it — and
//     rejecting one here would lock a real user out of their own instance with
//     no recourse but SQL, which is far worse than an inelegant legacy username.

export const MAX_USERNAME_LENGTH = 64;

// Tightened rule for new accounts: letters, digits, and . _ - (no spaces).
const USERNAME_CHARS_SOURCE = '[A-Za-z0-9_.\\-]+';
const USERNAME_CHARS = new RegExp(`^${USERNAME_CHARS_SOURCE}$`);

// The same rule as a string, for the signup forms' `pattern` attribute, so the
// browser hint and the server's 400 can't drift apart. It tolerates OUTER
// whitespace because the two are tested against different things: the server
// trims before validating, while the browser tests `pattern` against the raw
// field value — without the `\s*` a pasted " brad " would be blocked in the
// browser with "please match the requested format" even though the server
// accepts it. Inner whitespace is still refused by both.
export const USERNAME_PATTERN = `\\s*${USERNAME_CHARS_SOURCE}\\s*`;

// A login prompt only needs a SHAPE guard: the SQL is parameterized, so its
// only job is to reject junk before a pointless lookup. It deliberately applies
// NO charset or length rule, because it cannot know what's in the DB. Accounts
// seeded before 2026-05-09 (d834475) came in through INITIAL_USERNAME with no
// validation whatsoever, so an early self-host may hold 'björn', an email
// address, or a 70-character name — and a login guard that enforced today's
// charset would 400 those users at their own login prompt, which is the exact
// lockout the grandfathering exists to prevent. There is no rename route, so
// the only recourse would be SQL. The cap here is a payload sanity bound, NOT a
// username rule.
const MAX_SUBMITTED_USERNAME_LENGTH = 512;

function inBounds(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_USERNAME_LENGTH) return null;
  return trimmed;
}

/** May a NEW account be created with this name? */
export function isValidUsername(name: unknown): boolean {
  const trimmed = inBounds(name);
  return trimmed !== null && USERNAME_CHARS.test(trimmed);
}

/**
 * May this name be submitted at a login prompt? Deliberately far looser than
 * isValidUsername — see MAX_SUBMITTED_USERNAME_LENGTH above for why it can't
 * enforce a charset. Rejects only what could never identify any account: a
 * non-string, nothing but whitespace, or an absurdly long payload.
 */
export function isValidLoginUsername(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_SUBMITTED_USERNAME_LENGTH;
}

/**
 * Why an existing username wouldn't be creatable today, or null if it's fine.
 * Drives the one-line boot report that names grandfathered accounts, so an
 * operator finds out from a log line instead of from a confused user.
 */
export function nonConformingReason(name: string): string | null {
  if (isValidUsername(name)) return null;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  // Every applicable reason, not the first one found: the operator is deciding
  // what to rename this account TO, and a name that's both over-length and
  // spaced needs both facts. Length is checked explicitly because an unvalidated
  // legacy row can exceed the cap (see MAX_SUBMITTED_USERNAME_LENGTH above) —
  // folding that into the charset bucket would tell the operator to hunt for a
  // bad character that isn't there.
  const reasons: string[] = [];
  if (trimmed.length < 1) reasons.push('is blank');
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    reasons.push(`is longer than ${MAX_USERNAME_LENGTH} characters`);
  }
  if (/ /.test(trimmed)) reasons.push('contains a space');
  else if (/\s/.test(trimmed)) reasons.push('contains whitespace');
  if (trimmed.replace(/\s/g, '') !== '' && !USERNAME_CHARS.test(trimmed.replace(/\s/g, ''))) {
    reasons.push('contains characters no longer allowed');
  }
  // Belt: isValidUsername said no, so SOMETHING is wrong — never return a
  // grandfathered account with no explanation attached.
  return reasons.length > 0 ? reasons.join(' and ') : 'is not valid under the current rules';
}
