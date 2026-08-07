// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  isValidUsername,
  isValidLoginUsername,
  nonConformingReason,
  USERNAME_PATTERN,
  MAX_USERNAME_LENGTH,
} from './username.js';

describe('isValidUsername (creating an account)', () => {
  it('accepts letters, digits, and . _ -', () => {
    for (const name of ['brad', 'Brad', 'bob99', 'a.b', 'a_b', 'a-b', 'x'.repeat(64)]) {
      expect(isValidUsername(name)).toBe(true);
    }
  });

  it('rejects an inner space — the whole point of the tightening', () => {
    expect(isValidUsername('bob smith')).toBe(false);
    expect(isValidUsername('a  b')).toBe(false);
  });

  it('still trims an outer space rather than rejecting it', () => {
    // Trimming what someone pasted is kindness; allowing a space INSIDE the
    // stored name is the footgun. Only the latter is now refused.
    expect(isValidUsername(' brad ')).toBe(true);
  });

  it('rejects the empty string, overlong names, and non-strings', () => {
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('   ')).toBe(false);
    expect(isValidUsername('x'.repeat(MAX_USERNAME_LENGTH + 1))).toBe(false);
    expect(isValidUsername(null)).toBe(false);
    expect(isValidUsername(42)).toBe(false);
  });

  it('rejects control characters and exotic Unicode', () => {
    for (const name of ['bo\0b', 'bo\nb', 'héllo', '日本語', 'bob@host', 'bob/../etc']) {
      expect(isValidUsername(name)).toBe(false);
    }
  });

  it('USERNAME_PATTERN (the browser hint) agrees with the server rule', () => {
    // The signup form feeds this to an <input pattern>, which anchors it
    // implicitly and tests it against the RAW field value — while the server
    // trims first. Both cases matter: a disagreement either blocks a name the
    // server would take (bad: a pasted ' brad ' looks broken to the user) or
    // waves through one it rejects.
    const asHtmlWould = new RegExp(`^(?:${USERNAME_PATTERN})$`);
    for (const name of [
      'brad',
      'a.b-c_d',
      'bob smith',
      'héllo',
      '',
      ' brad ', // pasted with surrounding space — server trims, browser must allow
      '  ',
      '\tbrad\n',
    ]) {
      expect(asHtmlWould.test(name)).toBe(isValidUsername(name));
    }
  });
});

describe('isValidLoginUsername (submitting a name at login)', () => {
  it('accepts everything isValidUsername does', () => {
    for (const name of ['brad', 'Brad', 'a.b-c_d']) {
      expect(isValidLoginUsername(name)).toBe(true);
    }
  });

  it('ALSO accepts grandfathered names with spaces, so nobody is locked out', () => {
    // An account created before the tightening keeps its name; rejecting it here
    // would 400 at the login prompt with no recourse but SQL.
    expect(isValidUsername('bob smith')).toBe(false);
    expect(isValidLoginUsername('bob smith')).toBe(true);
  });

  it('ALSO accepts names no validator ever saw, which the DB may still hold', () => {
    // Accounts seeded via INITIAL_USERNAME before d834475 bypassed validation
    // entirely, so these can exist — and must still be able to authenticate.
    for (const name of ['björn', 'bob@example.com', 'x'.repeat(70), '日本語']) {
      expect(isValidUsername(name)).toBe(false);
      expect(isValidLoginUsername(name)).toBe(true);
    }
  });

  it('refuses only what could not identify any account at all', () => {
    for (const name of ['', '   ', null, 42, 'x'.repeat(513)]) {
      expect(isValidLoginUsername(name)).toBe(false);
    }
  });
});

describe('nonConformingReason', () => {
  it('names the reason for a legacy username, and stays silent for a fine one', () => {
    expect(nonConformingReason('bob smith')).toMatch(/space/);
    expect(nonConformingReason('brad')).toBeNull();
    expect(nonConformingReason('Brad')).toBeNull(); // case alone isn't a SHAPE problem
  });

  it('reports over-length as LENGTH, not as a bad character', () => {
    // The boot warning tells the operator what to fix. An unvalidated legacy row
    // can exceed the cap, and blaming the charset would send them hunting for a
    // bad character that isn't there.
    const reason = nonConformingReason('x'.repeat(MAX_USERNAME_LENGTH + 6))!;
    expect(reason).toMatch(/longer than 64/);
    expect(reason).not.toMatch(/characters no longer allowed/);
  });

  it('reports EVERY applicable reason, since the operator is picking a new name', () => {
    const reason = nonConformingReason('a very long legacy name '.repeat(4))!;
    expect(reason).toMatch(/longer than 64/);
    expect(reason).toMatch(/space/);
  });

  it('distinguishes a space from other whitespace, and names a blank', () => {
    expect(nonConformingReason('bo\tb')).toMatch(/whitespace/);
    expect(nonConformingReason('   ')).toMatch(/blank/);
  });

  it('never returns an empty explanation for a name it rejects', () => {
    // The boot line reads '#3 "x" — <reason>'; a null/empty reason there would
    // list an account with no stated problem.
    for (const name of ['björn', 'bo\0b', '日本語', '   ', 'x'.repeat(99), 'bob smith']) {
      expect(nonConformingReason(name)).toBeTruthy();
    }
  });
});
