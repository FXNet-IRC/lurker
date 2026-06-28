// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { decrypt, encrypt, generateSessionKey, KEY_LEN, NONCE_LEN } from './aead.js';
import { E2eError } from './errors.js';

const enc = new TextEncoder();

describe('aead (XChaCha20-Poly1305)', () => {
  it('round-trips plaintext bound to AAD', () => {
    const key = generateSessionKey();
    const aad = enc.encode('RPE2E01:sender@host:#chan:msgid:ts:1:1');
    const pt = enc.encode('hello world');
    const { nonce, ciphertext } = encrypt(key, aad, pt);
    expect(nonce.length).toBe(NONCE_LEN);
    expect(decrypt(key, nonce, aad, ciphertext)).toEqual(pt);
  });

  it('generates a 32-byte key and a fresh nonce each call', () => {
    expect(generateSessionKey().length).toBe(KEY_LEN);
    const key = generateSessionKey();
    const aad = enc.encode('ctx');
    const a = encrypt(key, aad, enc.encode('x'));
    const b = encrypt(key, aad, enc.encode('x'));
    expect(a.nonce).not.toEqual(b.nonce);
  });

  it('fails on an AAD mismatch', () => {
    const key = generateSessionKey();
    const { nonce, ciphertext } = encrypt(key, enc.encode('ctx-1'), enc.encode('secret'));
    expect(() => decrypt(key, nonce, enc.encode('ctx-2'), ciphertext)).toThrow(/aead decrypt/);
  });

  it('fails with the wrong key', () => {
    const aad = enc.encode('ctx');
    const { nonce, ciphertext } = encrypt(generateSessionKey(), aad, enc.encode('secret'));
    expect(() => decrypt(generateSessionKey(), nonce, aad, ciphertext)).toThrow(/aead decrypt/);
  });

  it('fails on a tampered ciphertext', () => {
    const key = generateSessionKey();
    const aad = enc.encode('ctx');
    const { nonce, ciphertext } = encrypt(key, aad, enc.encode('secret message'));
    ciphertext[0] ^= 0x01;
    expect(() => decrypt(key, nonce, aad, ciphertext)).toThrow(/aead decrypt/);
  });

  it('surfaces a wrong-length key/nonce as a crypto E2eError, not a raw RangeError', () => {
    const aad = enc.encode('ctx');
    let caught: unknown;
    try {
      encrypt(new Uint8Array(16), aad, enc.encode('x'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(E2eError);
    expect((caught as E2eError).kind).toBe('crypto');
    expect(() =>
      decrypt(new Uint8Array(16), new Uint8Array(NONCE_LEN), aad, new Uint8Array(20)),
    ).toThrow(/key must be/);
    expect(() =>
      decrypt(new Uint8Array(KEY_LEN), new Uint8Array(10), aad, new Uint8Array(20)),
    ).toThrow(/nonce must be/);
  });
});
