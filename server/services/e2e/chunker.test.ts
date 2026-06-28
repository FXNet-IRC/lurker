// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { splitPlaintext } from './chunker.js';
import { MAX_PLAINTEXT_PER_CHUNK } from './constants.js';

const dec = new TextDecoder();

describe('chunker', () => {
  it('keeps a short message as one chunk', () => {
    const chunks = splitPlaintext('hello');
    expect(chunks.length).toBe(1);
    expect(dec.decode(chunks[0])).toBe('hello');
  });

  it('refuses empty plaintext', () => {
    expect(() => splitPlaintext('')).toThrow(/empty plaintext/);
  });

  it('splits a long message into multiple chunks that rejoin exactly', () => {
    const s = 'x'.repeat(500);
    const chunks = splitPlaintext(s);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const rejoined = chunks.map((c) => dec.decode(c)).join('');
    expect(rejoined).toBe(s);
  });

  it('never splits inside a multi-byte UTF-8 character', () => {
    // Each pile-of-poo is 4 bytes; pad to force a split near the boundary.
    const prefix = 'x'.repeat(MAX_PLAINTEXT_PER_CHUNK - 2);
    const s = `${prefix}💩${prefix}`;
    const chunks = splitPlaintext(s);
    for (const c of chunks) {
      // Decoding with fatal:true throws if a chunk severs a character.
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(c)).not.toThrow();
    }
    expect(chunks.map((c) => dec.decode(c)).join('')).toBe(s);
  });

  it('errors when the message exceeds the chunk cap', () => {
    expect(() => splitPlaintext('a'.repeat(MAX_PLAINTEXT_PER_CHUNK * 17))).toThrow(
      /too many chunks/,
    );
  });
});
