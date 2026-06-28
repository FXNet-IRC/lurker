// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { buildAad } from './aad.js';

const msgid = (b: number) => new Uint8Array(8).fill(b);

describe('buildAad', () => {
  it('is deterministic', () => {
    expect(buildAad('#chan', msgid(1), 100, 1, 3)).toEqual(buildAad('#chan', msgid(1), 100, 1, 3));
  });

  it('is sensitive to every field', () => {
    const base = buildAad('#chan', msgid(1), 100, 1, 3);
    expect(base).not.toEqual(buildAad('#other', msgid(1), 100, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(2), 100, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 101, 1, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 100, 2, 3));
    expect(base).not.toEqual(buildAad('#chan', msgid(1), 100, 1, 4));
  });

  // Cross-client interop golden vector, taken verbatim from repartee's
  // wire.rs::build_aad_golden_vector. The weechat/Perl scripts produce the
  // same 40 bytes for these inputs — if this changes, interop breaks.
  it('matches the cross-client golden byte sequence', () => {
    const expected =
      '52504532453031' + // "RPE2E01"
      '0005' +
      '236368616e' + // be16(5) || "#chan"
      '0008' +
      '0101010101010101' + // be16(8) || msgid (8x 0x01)
      '0008' +
      '0000000000000064' + // be16(8) || ts=100 (i64 be)
      '0001' +
      '01' + // be16(1) || part=1
      '0001' +
      '03'; // be16(1) || total=3
    const got = buildAad('#chan', msgid(1), 100, 1, 3);
    expect(got.length).toBe(40);
    expect(Buffer.from(got).toString('hex')).toBe(expected);
  });

  // The length-prefixed layout keeps a channel containing ':' distinct from
  // any other arrangement that happens to concatenate the same bytes.
  it('length-prefix defeats colon ambiguity', () => {
    const a = buildAad('#a:b', msgid(1), 100, 1, 3);
    const b = buildAad('#a', msgid(1), 100, 1, 3);
    expect(a).not.toEqual(b);
    expect(a.length).not.toBe(b.length);
  });

  it('rejects a fractional ts instead of throwing a raw BigInt error', () => {
    expect(() => buildAad('#chan', msgid(1), 100.5, 1, 3)).toThrow(/ts must be an integer/);
  });

  it('rejects a wrong-length msgid', () => {
    expect(() => buildAad('#chan', new Uint8Array(5), 100, 1, 3)).toThrow(/msgid must be/);
  });

  it('rejects an out-of-range part/total instead of silently truncating', () => {
    expect(() => buildAad('#chan', msgid(1), 100, 300, 3)).toThrow(/part must be 0\.\.255/);
    expect(() => buildAad('#chan', msgid(1), 100, 1, 300)).toThrow(/total must be 0\.\.255/);
  });

  // Rust clamps the u16 length prefix to 0xFFFF and appends the full channel;
  // a >65535-byte channel must not throw a RangeError from writeUInt16BE.
  it('clamps an over-long channel length prefix instead of throwing', () => {
    expect(() => buildAad('#' + 'a'.repeat(70000), msgid(1), 100, 1, 3)).not.toThrow();
  });
});
