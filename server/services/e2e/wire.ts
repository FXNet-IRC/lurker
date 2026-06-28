// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// RPE2E01 wire format: encode/parse `+RPE2E01 <msgid> <ts> <part>/<total> <nonce_b64>:<ct_b64>`.
//
// Each chunk is a standalone cryptographic unit — receivers decrypt and render
// immediately, with no reassembly state. The nonce and ciphertext use STANDARD
// base64 (with padding) — NOTE this differs from the handshake messages, which
// use URL-safe-no-pad. `msgid` is 8 random bytes, lowercase-hex on the wire.
//
// Rust gets length/range invariants for free from its fixed-size array types
// (`[u8;8]`, `[u8;24]`); this port re-establishes them with explicit guards so
// malformed/oversize input is rejected as `E2eError` rather than producing a
// silently-malformed line or escaping as a raw RangeError.

import { randomBytes } from 'node:crypto';

import { NONCE_LEN } from './aead.js';
import { MAX_CHUNKS, MSGID_LEN, WIRE_PREFIX } from './constants.js';
import { parseUintStrict, tryDecodeStdBase64 } from './encoding.js';
import { chunkLimitError, wireError } from './errors.js';

export interface WireChunk {
  /** 8-byte message id, shared across all chunks of one logical message. */
  msgid: Uint8Array;
  /** Unix seconds (i64 on the wire / in the AAD). */
  ts: number;
  /** 1-indexed chunk number. */
  part: number;
  /** Total chunk count (1..=16). */
  total: number;
  /** 24-byte XChaCha20 nonce. */
  nonce: Uint8Array;
  /** AEAD ciphertext (includes the Poly1305 tag). */
  ciphertext: Uint8Array;
}

/** Serialize a chunk into a single IRC-safe line (no trailing newline). */
export function encodeChunk(chunk: WireChunk): string {
  const { msgid, ts, part, total, nonce, ciphertext } = chunk;
  if (msgid.length !== MSGID_LEN) {
    throw wireError(`msgid must be ${MSGID_LEN} bytes, got ${msgid.length}`);
  }
  if (nonce.length !== NONCE_LEN) {
    throw wireError(`nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }
  // total out of range is a chunk-limit condition (matches repartee's
  // ChunkLimit), distinct from an invalid part/total relationship.
  if (total === 0 || total > MAX_CHUNKS) throw chunkLimitError(total);
  if (part === 0 || part > total) throw wireError(`invalid part/total: ${part}/${total}`);

  const msgidHex = Buffer.from(msgid).toString('hex');
  const nonceB64 = Buffer.from(nonce).toString('base64');
  const ctB64 = Buffer.from(ciphertext).toString('base64');
  return `${WIRE_PREFIX} ${msgidHex} ${ts} ${part}/${total} ${nonceB64}:${ctB64}`;
}

/**
 * Parse an incoming line. Returns `null` if it is not an RPE2E01 chunk (i.e.
 * cleartext), or throws `E2eError('wire')` if it is malformed.
 */
export function parseChunk(line: string): WireChunk | null {
  if (!line.startsWith(WIRE_PREFIX)) return null;
  const rest = line.slice(WIRE_PREFIX.length);
  const fields = rest.split(/\s+/).filter((f) => f.length > 0);
  if (fields.length !== 4) {
    throw wireError(fields.length < 4 ? 'missing fields' : 'extra fields');
  }
  const [msgidHex, tsStr, partTot, body] = fields;

  if (msgidHex.length !== MSGID_LEN * 2 || !/^[0-9a-fA-F]+$/.test(msgidHex)) {
    throw wireError('msgid must be 16 hex chars');
  }
  const msgid = new Uint8Array(Buffer.from(msgidHex, 'hex'));

  // i64 on the wire; reject anything we can't represent exactly (a >2^53 ts
  // would silently lose precision and break the reconstructed AAD).
  if (!/^-?\d+$/.test(tsStr)) throw wireError(`bad ts: ${tsStr}`);
  const ts = Number(tsStr);
  if (!Number.isSafeInteger(ts)) throw wireError(`ts out of range: ${tsStr}`);

  const slash = partTot.indexOf('/');
  if (slash < 0) throw wireError('part/total missing slash');
  const part = parseUintStrict(partTot.slice(0, slash));
  const total = parseUintStrict(partTot.slice(slash + 1));
  if (
    part === null ||
    total === null ||
    total === 0 ||
    total > MAX_CHUNKS ||
    part === 0 ||
    part > total
  ) {
    throw wireError(`bad part/total ${partTot}`);
  }

  const colon = body.indexOf(':');
  if (colon < 0) throw wireError('missing nonce:ct separator');
  const nonce = tryDecodeStdBase64(body.slice(0, colon));
  if (!nonce || nonce.length !== NONCE_LEN) {
    throw wireError(`nonce must be ${NONCE_LEN} bytes, got ${nonce?.length ?? 'invalid base64'}`);
  }
  const ciphertext = tryDecodeStdBase64(body.slice(colon + 1));
  if (!ciphertext) throw wireError('invalid ciphertext base64');

  return { msgid, ts, part, total, nonce, ciphertext };
}

/** Generate a fresh 8-byte random message id. */
export function freshMsgid(): Uint8Array {
  return new Uint8Array(randomBytes(MSGID_LEN));
}
