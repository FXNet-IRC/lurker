// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// RPE2E CTCP handshake: KEYREQ / KEYRSP / REKEY encode + parse, plus the
// canonical signed-payload builders.
//
// Wire form (inside the CTCP `\x01 ... \x01` framing, sent via NOTICE):
//
//   RPEE2E KEYREQ v=1 c=#x p=<b64u32> e=<b64u32> n=<b64u16> s=<b64u64>
//   RPEE2E KEYRSP v=1 c=#x p=<b64u32> e=<b64u32> wn=<b64u24> w=<b64u> n=<b64u16> s=<b64u64>
//   RPEE2E REKEY  v=1 c=#x p=<b64u32> e=<b64u32> wn=<b64u24> w=<b64u> n=<b64u16> s=<b64u64>
//
// All fields use URL-safe base64 WITHOUT padding (NOTE: the message wire format
// in wire.ts uses standard base64 — the two are deliberately different). `p` is
// the sender's long-term Ed25519 identity; `e` is an ephemeral X25519 public.
// The ephemeral is bound into the signature so a MitM cannot swap it without
// breaking the Ed25519 signature.
//
// NOTE: repartee's handshake rate limiter (handshake.rs §5.4 — 3 incoming
// KEYREQ/min then a 5-minute backoff, 30s outgoing gap) is intentionally NOT
// here. It is stateful manager-layer policy; this module is the pure wire codec
// per index.ts. It MUST be implemented in the manager layer before E2E goes
// live, since it gates the expensive Ed25519 verify against KEYREQ floods.

import { NONCE_LEN } from './aead.js';
import { CTCP_TAG, PROTO_VERSION } from './constants.js';
import { parseUintStrict, tryDecodeUrlBase64, utf8 } from './encoding.js';
import { handshakeError, wireError } from './errors.js';

export interface KeyReq {
  channel: string;
  pubkey: Uint8Array; // 32 — initiator Ed25519 identity
  ephX25519: Uint8Array; // 32 — initiator ephemeral X25519
  nonce: Uint8Array; // 16 — anti-replay
  sig: Uint8Array; // 64
}

export interface KeyRsp {
  channel: string;
  pubkey: Uint8Array; // 32 — responder Ed25519 identity
  ephemeralPub: Uint8Array; // 32 — responder ephemeral X25519
  wrapNonce: Uint8Array; // 24
  wrapCt: Uint8Array; // variable — wrapped session key
  nonce: Uint8Array; // 16
  sig: Uint8Array; // 64
}

export interface KeyRekey {
  channel: string;
  pubkey: Uint8Array; // 32 — sender Ed25519 identity
  ephPub: Uint8Array; // 32 — fresh ephemeral X25519
  wrapNonce: Uint8Array; // 24
  wrapCt: Uint8Array; // variable
  nonce: Uint8Array; // 16
  sig: Uint8Array; // 64
}

export type HandshakeMsg =
  | { kind: 'KEYREQ'; msg: KeyReq }
  | { kind: 'KEYRSP'; msg: KeyRsp }
  | { kind: 'REKEY'; msg: KeyRekey };

// ─── canonical signed payloads ───────────────────────────────────────────────

const COLON = Uint8Array.of(0x3a);

// `<LABEL>:` || channel || (':' || part) for each part. One builder for all
// three message types — the KEYRSP and REKEY layouts are byte-identical but for
// the label, so a single source keeps them from silently drifting apart from
// the reference (and thus producing signatures that no longer verify).
function buildSigPayload(label: string, channel: string, ...parts: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [utf8.encode(`${label}:`), utf8.encode(channel)];
  for (const p of parts) chunks.push(COLON, p);
  return Buffer.concat(chunks);
}

/** `"KEYREQ:" || channel || ':' || pubkey || ':' || eph_x25519 || ':' || nonce` */
export function sigPayloadKeyReq(
  channel: string,
  pubkey: Uint8Array,
  ephX25519: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return buildSigPayload('KEYREQ', channel, pubkey, ephX25519, nonce);
}

/** `"KEYRSP:" || channel || ':' || pubkey || ':' || eph_pub || ':' || wrap_nonce || ':' || wrap_ct || ':' || nonce` */
export function sigPayloadKeyRsp(
  channel: string,
  pubkey: Uint8Array,
  ephPub: Uint8Array,
  wrapNonce: Uint8Array,
  wrapCt: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return buildSigPayload('KEYRSP', channel, pubkey, ephPub, wrapNonce, wrapCt, nonce);
}

/** `"REKEY:" || channel || ':' || pubkey || ':' || eph_pub || ':' || wrap_nonce || ':' || wrap_ct || ':' || nonce` */
export function sigPayloadKeyRekey(
  channel: string,
  pubkey: Uint8Array,
  ephPub: Uint8Array,
  wrapNonce: Uint8Array,
  wrapCt: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  return buildSigPayload('REKEY', channel, pubkey, ephPub, wrapNonce, wrapCt, nonce);
}

// ─── base64url helpers ───────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function b64Decode(s: string, field: string): Uint8Array {
  const raw = tryDecodeUrlBase64(s);
  if (!raw) throw handshakeError(`${field}: invalid base64`);
  return raw;
}

function b64Fixed(s: string, n: number, field: string): Uint8Array {
  const raw = b64Decode(s, field);
  if (raw.length !== n) {
    throw handshakeError(`${field}: expected ${n} bytes, got ${raw.length}`);
  }
  return raw;
}

/** Fail fast if an encode field is the wrong size — a public wire codec should
 *  never silently serialize a non-interoperable handshake line. */
function assertLen(bytes: Uint8Array, n: number, field: string): void {
  if (bytes.length !== n) {
    throw handshakeError(`${field}: expected ${n} bytes, got ${bytes.length}`);
  }
}

// ─── encode ──────────────────────────────────────────────────────────────────

export function encodeKeyReq(req: KeyReq): string {
  assertLen(req.pubkey, 32, 'p');
  assertLen(req.ephX25519, 32, 'e');
  assertLen(req.nonce, 16, 'n');
  assertLen(req.sig, 64, 's');
  return (
    `${CTCP_TAG} KEYREQ v=${PROTO_VERSION} c=${req.channel} ` +
    `p=${b64(req.pubkey)} e=${b64(req.ephX25519)} n=${b64(req.nonce)} s=${b64(req.sig)}`
  );
}

export function encodeKeyRsp(rsp: KeyRsp): string {
  assertLen(rsp.pubkey, 32, 'p');
  assertLen(rsp.ephemeralPub, 32, 'e');
  assertLen(rsp.wrapNonce, NONCE_LEN, 'wn');
  assertLen(rsp.nonce, 16, 'n');
  assertLen(rsp.sig, 64, 's');
  return (
    `${CTCP_TAG} KEYRSP v=${PROTO_VERSION} c=${rsp.channel} ` +
    `p=${b64(rsp.pubkey)} e=${b64(rsp.ephemeralPub)} wn=${b64(rsp.wrapNonce)} ` +
    `w=${b64(rsp.wrapCt)} n=${b64(rsp.nonce)} s=${b64(rsp.sig)}`
  );
}

export function encodeKeyRekey(rk: KeyRekey): string {
  assertLen(rk.pubkey, 32, 'p');
  assertLen(rk.ephPub, 32, 'e');
  assertLen(rk.wrapNonce, NONCE_LEN, 'wn');
  assertLen(rk.nonce, 16, 'n');
  assertLen(rk.sig, 64, 's');
  return (
    `${CTCP_TAG} REKEY v=${PROTO_VERSION} c=${rk.channel} ` +
    `p=${b64(rk.pubkey)} e=${b64(rk.ephPub)} wn=${b64(rk.wrapNonce)} ` +
    `w=${b64(rk.wrapCt)} n=${b64(rk.nonce)} s=${b64(rk.sig)}`
  );
}

// ─── parse ───────────────────────────────────────────────────────────────────

/**
 * Parse the body inside the `\x01...\x01` CTCP framing. Returns `null` when the
 * body is not an RPEE2E message (so callers can fall through to other CTCP
 * handling). Throws `E2eError` on a malformed/unsupported RPEE2E message.
 *
 * Duplicate keys are rejected outright: an ambiguous body like `c=#a c=#b`
 * could otherwise shift the semantic channel of an already-signed message.
 */
export function parseHandshake(body: string): HandshakeMsg | null {
  const parts = body.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts[0] !== CTCP_TAG) return null;
  if (parts.length < 2) throw handshakeError('missing type');
  const kind = parts[1];

  const kv = parseKv(parts.slice(2));

  const vStr = kv.get('v');
  if (vStr === undefined) throw handshakeError('missing v');
  const v = parseUintStrict(vStr);
  if (v === null) throw handshakeError(`bad v: ${vStr}`);
  if (v !== PROTO_VERSION) throw handshakeError(`unsupported version ${v}`);

  const get = (key: string): string => {
    const val = kv.get(key);
    if (val === undefined) throw handshakeError(`missing field: ${key}`);
    return val;
  };

  switch (kind) {
    case 'KEYREQ':
      return {
        kind: 'KEYREQ',
        msg: {
          channel: get('c'),
          pubkey: b64Fixed(get('p'), 32, 'p'),
          ephX25519: b64Fixed(get('e'), 32, 'e'),
          nonce: b64Fixed(get('n'), 16, 'n'),
          sig: b64Fixed(get('s'), 64, 's'),
        },
      };
    case 'KEYRSP':
      return {
        kind: 'KEYRSP',
        msg: {
          channel: get('c'),
          pubkey: b64Fixed(get('p'), 32, 'p'),
          ephemeralPub: b64Fixed(get('e'), 32, 'e'),
          wrapNonce: b64Fixed(get('wn'), NONCE_LEN, 'wn'),
          wrapCt: b64Decode(get('w'), 'w'),
          nonce: b64Fixed(get('n'), 16, 'n'),
          sig: b64Fixed(get('s'), 64, 's'),
        },
      };
    case 'REKEY':
      return {
        kind: 'REKEY',
        msg: {
          channel: get('c'),
          pubkey: b64Fixed(get('p'), 32, 'p'),
          ephPub: b64Fixed(get('e'), 32, 'e'),
          wrapNonce: b64Fixed(get('wn'), NONCE_LEN, 'wn'),
          wrapCt: b64Decode(get('w'), 'w'),
          nonce: b64Fixed(get('n'), 16, 'n'),
          sig: b64Fixed(get('s'), 64, 's'),
        },
      };
    default:
      throw handshakeError(`unknown type ${kind}`);
  }
}

/**
 * Parse `k=v` fields, rejecting any duplicate key. The duplicate-key error is
 * intentionally `wireError` (kind `'wire'`), not `handshakeError`, to mirror
 * repartee's `parse_kv`, which returns `E2eError::Wire` here — a structural
 * key/value parse failure, conceptually shared with the chunk parser. Keeping
 * the kind aligned with the reference is deliberate; do not "fix" it to
 * `'handshake'`.
 */
function parseKv(fields: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fields) {
    const eq = f.indexOf('=');
    if (eq < 0) continue;
    const k = f.slice(0, eq);
    const v = f.slice(eq + 1);
    if (out.has(k)) throw wireError(`duplicate key: ${k}`);
    out.set(k, v);
  }
  return out;
}
