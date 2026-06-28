// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Additional Authenticated Data (AAD) construction for an RPE2E01 chunk.
//
// AAD layout (length-prefixed, big-endian):
//
//   PROTO(7 bytes, fixed)
//     || be16(channel.len) || channel
//     || be16(8)           || msgid (8 bytes)
//     || be16(8)           || ts_be (8 bytes, i64)
//     || be16(1)           || part  (1 byte)
//     || be16(1)           || total (1 byte)
//
// Every non-const field carries a u16 big-endian length prefix — even the
// fixed-size ones — so the layout is position-independent and no crafted
// channel name (e.g. one containing ':') can shift later fields. The 7-byte
// PROTO prefix is constant and therefore not length-prefixed.
//
// The sender handle is deliberately NOT in the AAD: sender authentication is
// enforced at the keyring layer (decrypt looks up the session by
// (handle_from_IRC_prefix, channel)), and the sender does not always know its
// own ident@host before encrypting. This mirrors repartee exactly; the golden
// vector in aad.test.ts pins the byte sequence for interop.

import { MSGID_LEN, PROTO } from './constants.js';
import { utf8 } from './encoding.js';
import { wireError } from './errors.js';

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function be16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** Validate `ts` is an exact integer within the i64 range and return it as a bigint. */
function toI64(ts: number | bigint): bigint {
  if (typeof ts === 'number') {
    if (!Number.isSafeInteger(ts)) throw wireError(`ts must be an integer, got ${ts}`);
    return BigInt(ts);
  }
  if (ts < I64_MIN || ts > I64_MAX) throw wireError(`ts out of i64 range: ${ts}`);
  return ts;
}

/** Validate a single-byte (u8) field so it can't be silently truncated. The
 *  1..total relationship is the encoder's job (matching repartee's split); here
 *  we only guarantee the value fits in the byte the AAD encodes. */
function u8(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw wireError(`${field} must be 0..255, got ${n}`);
  }
  return n;
}

/**
 * Build the AAD for a single chunk. `msgid` must be exactly 8 bytes; `ts` is
 * unix seconds (encoded as a big-endian i64); `part`/`total` are 1-indexed.
 */
export function buildAad(
  channel: string,
  msgid: Uint8Array,
  ts: number | bigint,
  part: number,
  total: number,
): Uint8Array {
  if (msgid.length !== MSGID_LEN) {
    throw wireError(`msgid must be ${MSGID_LEN} bytes, got ${msgid.length}`);
  }
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigInt64BE(toI64(ts));

  const chan = utf8.encode(channel);
  return Buffer.concat([
    utf8.encode(PROTO), // "RPE2E01" (7 bytes, not length-prefixed)
    // Clamp the length prefix to u16::MAX as repartee does; the full channel
    // bytes still follow, so honest peers agree byte-for-byte even past 65535.
    be16(Math.min(chan.length, 0xffff)),
    chan,
    be16(8),
    Buffer.from(msgid),
    be16(8),
    tsBuf,
    be16(1),
    Buffer.from([u8(part, 'part')]),
    be16(1),
    Buffer.from([u8(total, 'total')]),
  ]);
}
