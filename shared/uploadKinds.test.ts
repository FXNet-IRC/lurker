// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { UPLOAD_KINDS, extraMimesForKind, isUploadKind, mimeMatchesKind } from './uploadKinds.js';

describe('mimeMatchesKind', () => {
  it('matches on the kind prefix', () => {
    expect(mimeMatchesKind('image/webp', 'image')).toBe(true);
    expect(mimeMatchesKind('video/mp4', 'video')).toBe(true);
    expect(mimeMatchesKind('audio/mpeg', 'audio')).toBe(true);
    expect(mimeMatchesKind('text/plain', 'text')).toBe(true);
    expect(mimeMatchesKind('text/markdown', 'text')).toBe(true);
  });

  // ⚠ The whole reason this module exists (#788). JSON is a text file IANA files under
  // `application/`, so a prefix match misses it and an uploaded `.json` is invisible
  // under every filter the uploads browser offers.
  it('matches JSON under text, which its prefix does not', () => {
    expect(mimeMatchesKind('application/json', 'text')).toBe(true);
  });

  it('does not let an extra mime leak into another kind', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(mimeMatchesKind('application/json', kind)).toBe(false);
    }
  });

  it('is not a blanket application/ pass', () => {
    expect(mimeMatchesKind('application/pdf', 'text')).toBe(false);
    expect(mimeMatchesKind('application/zip', 'text')).toBe(false);
  });

  // A prefix match must be on the SEGMENT, so a kind can't match a mime that merely
  // starts with its letters.
  it('will not match a mime that only starts with the kind name', () => {
    expect(mimeMatchesKind('imagefoo/bar', 'image')).toBe(false);
    expect(mimeMatchesKind('textual/plain', 'text')).toBe(false);
  });

  it('treats a missing mime as matching nothing', () => {
    for (const kind of UPLOAD_KINDS) {
      expect(mimeMatchesKind(null, kind)).toBe(false);
      expect(mimeMatchesKind('', kind)).toBe(false);
    }
  });

  // The server interpolates extras into a SQL clause as bound literals. Any mime with
  // a LIKE metacharacter in it would be a bug there, so pin the shape at the source.
  it('exposes extras as plain literal mimes', () => {
    for (const kind of UPLOAD_KINDS) {
      for (const mime of extraMimesForKind(kind)) {
        expect(mime).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
        // An extra that its own prefix already covers is dead weight, and a sign the
        // table and the kind list have drifted.
        expect(mime.startsWith(`${kind}/`)).toBe(false);
      }
    }
  });
});

describe('isUploadKind', () => {
  it('accepts exactly the declared kinds', () => {
    for (const kind of UPLOAD_KINDS) expect(isUploadKind(kind)).toBe(true);
  });

  // It guards a query parameter that becomes part of a SQL clause, so everything else
  // has to fail — including the near-misses.
  it('rejects anything else', () => {
    for (const value of ['', 'texts', 'TEXT', 'application', null, undefined, 7, {}]) {
      expect(isUploadKind(value)).toBe(false);
    }
  });
});
