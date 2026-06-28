// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Stateless plaintext chunker. Splits a message into N <= MAX_CHUNKS pieces,
// each at most MAX_PLAINTEXT_PER_CHUNK bytes, on UTF-8 character boundaries.
// Each chunk becomes an independent encrypted line — the receiver never
// reassembles (architecture spec section 6).

import { MAX_CHUNKS, MAX_PLAINTEXT_PER_CHUNK } from './constants.js';
import { utf8 } from './encoding.js';
import { chunkLimitError, wireError } from './errors.js';

/** True if `byte` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Split `plaintext` into UTF-8 chunks. Empty input is refused (so a caller
 * cannot ship a zero-length-ciphertext chunk that renders as a blank line).
 * Throws if a single character exceeds the chunk budget or the message needs
 * more than MAX_CHUNKS chunks.
 */
export function splitPlaintext(plaintext: string): Uint8Array[] {
  if (plaintext.length === 0) throw wireError('empty plaintext');

  const bytes = utf8.encode(plaintext);
  const chunks: Uint8Array[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    let end = Math.min(cursor + MAX_PLAINTEXT_PER_CHUNK, bytes.length);
    // Walk back to a UTF-8 boundary if we landed mid-sequence. `end < length`
    // is explicit (the end of the buffer is always a boundary) rather than
    // relying on `bytes[length]` coercing to `undefined`.
    while (end > cursor && end < bytes.length && isContinuation(bytes[end])) {
      end -= 1;
    }
    if (end === cursor) {
      throw wireError('cannot split: single UTF-8 char exceeds chunk budget');
    }
    chunks.push(bytes.subarray(cursor, end));
    cursor = end;

    if (chunks.length > MAX_CHUNKS) throw chunkLimitError(chunks.length);
  }

  if (chunks.length > MAX_CHUNKS) throw chunkLimitError(chunks.length);
  return chunks;
}
