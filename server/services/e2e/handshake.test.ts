// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import {
  encodeKeyRekey,
  encodeKeyReq,
  encodeKeyRsp,
  type KeyRekey,
  type KeyReq,
  type KeyRsp,
  parseHandshake,
  sigPayloadKeyRekey,
  sigPayloadKeyReq,
} from './handshake.js';

const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function sampleReq(): KeyReq {
  return {
    channel: '#x',
    pubkey: fill(32, 1),
    ephX25519: fill(32, 9),
    nonce: fill(16, 2),
    sig: fill(64, 3),
  };
}
function sampleRsp(): KeyRsp {
  return {
    channel: '#x',
    pubkey: fill(32, 12),
    ephemeralPub: fill(32, 4),
    wrapNonce: fill(24, 5),
    wrapCt: new Uint8Array([6, 7, 8, 9]),
    nonce: fill(16, 10),
    sig: fill(64, 11),
  };
}
function sampleRekey(): KeyRekey {
  return {
    channel: '#x',
    pubkey: fill(32, 13),
    ephPub: fill(32, 14),
    wrapNonce: fill(24, 15),
    wrapCt: new Uint8Array([16, 17, 18, 19, 20]),
    nonce: fill(16, 21),
    sig: fill(64, 22),
  };
}

describe('handshake codec', () => {
  it('round-trips KEYREQ', () => {
    const parsed = parseHandshake(encodeKeyReq(sampleReq()));
    expect(parsed).toEqual({ kind: 'KEYREQ', msg: sampleReq() });
  });

  it('round-trips KEYRSP', () => {
    const parsed = parseHandshake(encodeKeyRsp(sampleRsp()));
    expect(parsed).toEqual({ kind: 'KEYRSP', msg: sampleRsp() });
  });

  it('round-trips REKEY', () => {
    const parsed = parseHandshake(encodeKeyRekey(sampleRekey()));
    expect(parsed).toEqual({ kind: 'REKEY', msg: sampleRekey() });
  });

  it('returns null for a non-RPEE2E body', () => {
    expect(parseHandshake('SOMETHING ELSE')).toBeNull();
    expect(parseHandshake('')).toBeNull();
  });

  it('rejects a duplicate key (would let a crafted body shift the channel)', () => {
    const line =
      `RPEE2E KEYREQ v=1 c=#a c=#b p=${b64(fill(32, 0))} e=${b64(fill(32, 0))} ` +
      `n=${b64(fill(16, 0))} s=${b64(fill(64, 0))}`;
    expect(() => parseHandshake(line)).toThrow(/duplicate key: c/);
  });

  it('rejects a duplicate wrap field in KEYRSP', () => {
    const line =
      `RPEE2E KEYRSP v=1 c=#x p=${b64(fill(32, 0))} e=${b64(fill(32, 0))} ` +
      `wn=${b64(fill(24, 0))} w=${b64(fill(4, 0))} w=${b64(fill(4, 1))} ` +
      `n=${b64(fill(16, 0))} s=${b64(fill(64, 0))}`;
    expect(() => parseHandshake(line)).toThrow(/duplicate key: w/);
  });

  it('rejects an unsupported version', () => {
    const line =
      `RPEE2E KEYREQ v=9 c=#x p=${b64(fill(32, 0))} e=${b64(fill(32, 0))} ` +
      `n=${b64(fill(16, 0))} s=${b64(fill(64, 0))}`;
    expect(() => parseHandshake(line)).toThrow(/unsupported version/);
  });

  it('rejects a non-canonical version that Number() would accept (1.0)', () => {
    const line =
      `RPEE2E KEYREQ v=1.0 c=#x p=${b64(fill(32, 0))} e=${b64(fill(32, 0))} ` +
      `n=${b64(fill(16, 0))} s=${b64(fill(64, 0))}`;
    expect(() => parseHandshake(line)).toThrow(/bad v/);
  });

  it('rejects invalid base64 in a field', () => {
    const line =
      `RPEE2E KEYREQ v=1 c=#x p=not*valid*b64 e=${b64(fill(32, 0))} ` +
      `n=${b64(fill(16, 0))} s=${b64(fill(64, 0))}`;
    expect(() => parseHandshake(line)).toThrow(/invalid base64/);
  });

  it('fails fast on a wrong-length field at encode time', () => {
    expect(() => encodeKeyReq({ ...sampleReq(), pubkey: fill(16, 1) })).toThrow(/p: expected 32/);
    expect(() => encodeKeyRsp({ ...sampleRsp(), sig: fill(10, 1) })).toThrow(/s: expected 64/);
  });

  it('binds the ephemeral X25519 into the KEYREQ signed payload', () => {
    const p1 = sigPayloadKeyReq('#x', fill(32, 1), fill(32, 9), fill(16, 2));
    const p2 = sigPayloadKeyReq('#x', fill(32, 1), fill(32, 8), fill(16, 2));
    expect(p1).not.toEqual(p2);
  });

  it('binds the ephemeral and ciphertext into the REKEY signed payload', () => {
    const base = sigPayloadKeyRekey(
      '#x',
      fill(32, 1),
      fill(32, 2),
      fill(24, 3),
      new Uint8Array([4, 5]),
      fill(16, 6),
    );
    const diffEph = sigPayloadKeyRekey(
      '#x',
      fill(32, 1),
      fill(32, 9),
      fill(24, 3),
      new Uint8Array([4, 5]),
      fill(16, 6),
    );
    const diffCt = sigPayloadKeyRekey(
      '#x',
      fill(32, 1),
      fill(32, 2),
      fill(24, 3),
      new Uint8Array([4, 6]),
      fill(16, 6),
    );
    expect(base).not.toEqual(diffEph);
    expect(base).not.toEqual(diffCt);
  });

  it('KEYRSP fits under the 512-byte IRC line limit even with a long prefix', () => {
    const rsp: KeyRsp = { ...sampleRsp(), channel: '#irc.al', wrapCt: fill(48, 6) };
    const body = `\x01${encodeKeyRsp(rsp)}\x01`;
    const prefix = ':nick!^prostatut@2a14:7584:44e4:7af6:c219:38d4:e5b7:1c63 NOTICE kofany_ :';
    expect(`${prefix}${body}\r\n`.length).toBeLessThanOrEqual(512);
  });
});
