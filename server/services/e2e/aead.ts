// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// XChaCha20-Poly1305 AEAD, used for both message encryption and session-key
// wrapping. 32-byte key, 24-byte nonce (fresh-random per call), Poly1305 tag
// appended to the ciphertext. This is a single well-defined algorithm, so any
// conformant implementation (repartee's Rust, the weechat/Perl scripts) that
// agrees on key, nonce, and AAD produces interoperable ciphertext.

import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { cryptoError } from './errors.js';

export const KEY_LEN = 32;
export const NONCE_LEN = 24;

export interface Sealed {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Encrypt `plaintext` binding `aad`. A fresh random 24-byte nonce is generated
 * per call. Returns the nonce and the ciphertext (which includes the tag).
 */
export function encrypt(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Sealed {
  if (key.length !== KEY_LEN) throw cryptoError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  try {
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return { nonce, ciphertext };
  } catch (err) {
    throw cryptoError(`aead encrypt: ${(err as Error).message}`);
  }
}

/**
 * Decrypt `ciphertext` using `nonce` and `aad`. Throws `E2eError('crypto')`
 * on tag mismatch (wrong key, tampered ciphertext, or wrong AAD).
 */
export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_LEN) throw cryptoError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  if (nonce.length !== NONCE_LEN) {
    throw cryptoError(`nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch (err) {
    throw cryptoError(`aead decrypt: ${(err as Error).message}`);
  }
}

/** Generate a fresh 32-byte symmetric session key. */
export function generateSessionKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LEN));
}
