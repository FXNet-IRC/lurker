// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { foldTargetWith, normalizeCasemapping } from './casemapping.js';

describe('normalizeCasemapping', () => {
  it('accepts the four known values, case-insensitively', () => {
    expect(normalizeCasemapping('ascii')).toBe('ascii');
    expect(normalizeCasemapping('RFC1459')).toBe('rfc1459');
    expect(normalizeCasemapping('rfc1459-strict')).toBe('rfc1459-strict');
    expect(normalizeCasemapping('rfc7613')).toBe('rfc7613');
    expect(normalizeCasemapping('utf8')).toBe('rfc7613');
  });

  it("accepts irc-framework's strict-rfc1459 spelling", () => {
    expect(normalizeCasemapping('strict-rfc1459')).toBe('rfc1459-strict');
  });

  it('rejects everything else — an unknown mapping must not be stored', () => {
    expect(normalizeCasemapping('rfc8265')).toBeUndefined();
    expect(normalizeCasemapping('')).toBeUndefined();
    expect(normalizeCasemapping(undefined)).toBeUndefined();
    expect(normalizeCasemapping(42)).toBeUndefined();
  });
});

describe('foldTargetWith', () => {
  it('ascii folds A-Z and nothing else', () => {
    expect(foldTargetWith('ascii', '#FooBar')).toBe('#foobar');
    expect(foldTargetWith('ascii', '#foo[BAR]\\^~')).toBe('#foo[bar]\\^~');
    // Unicode stays: ascii means ascii.
    expect(foldTargetWith('ascii', '#Ärger')).toBe('#Ärger');
  });

  it('rfc1459 additionally folds [ \\ ] ^ down to { | } ~', () => {
    // The Scandinavian pairing: #foo[bar] and #foo{bar} are the same channel.
    expect(foldTargetWith('rfc1459', '#foo[bar]')).toBe('#foo{bar}');
    expect(foldTargetWith('rfc1459', '#a\\b')).toBe('#a|b');
    // ⚠ Direction: ^ is the UPPERCASE of ~ (ircd tolower tables and
    // irc-framework's bound of 94), despite RFC 2812's prose reading the
    // other way. ^ folds down; ~ is already lowercase and stays.
    expect(foldTargetWith('rfc1459', 'nick^')).toBe('nick~');
    expect(foldTargetWith('rfc1459', 'nick~')).toBe('nick~');
  });

  it('rfc1459-strict folds the brackets but leaves ^ alone', () => {
    expect(foldTargetWith('rfc1459-strict', '#Foo[Bar]\\')).toBe('#foo{bar}|');
    expect(foldTargetWith('rfc1459-strict', 'nick^')).toBe('nick^');
  });

  it('rfc7613 and no-mapping use the legacy Unicode fold', () => {
    // The rule every pre-#707 target_folded row was built with — an
    // undeclared network's registry must not churn.
    expect(foldTargetWith('rfc7613', '#Ärger')).toBe('#ärger');
    expect(foldTargetWith(null, '#Ärger')).toBe('#ärger');
    expect(foldTargetWith(undefined, '#foo[BAR]')).toBe('#foo[bar]');
  });
});
