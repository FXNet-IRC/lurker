// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Long-term Ed25519 identity keypair, plus signature helpers for the
// handshake. The secret is the raw 32-byte seed (NOT an expanded key), and
// the public key is the 32-byte compressed point — the same serialization
// repartee and libsodium-based peers use, so identities are portable.

import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

import { cryptoError } from './errors.js';

export const SECRET_LEN = 32;
export const PUBLIC_LEN = 32;
export const SIG_LEN = 64;

export interface Identity {
  /** 32-byte Ed25519 secret seed. */
  secretKey: Uint8Array;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

/** Generate a fresh identity from the OS CSPRNG. */
export function generateIdentity(): Identity {
  return identityFromSeed(new Uint8Array(randomBytes(SECRET_LEN)));
}

/** Load an identity from a raw 32-byte secret seed. */
export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== SECRET_LEN) {
    throw cryptoError(`identity seed must be ${SECRET_LEN} bytes, got ${seed.length}`);
  }
  return { secretKey: seed, publicKey: ed25519.getPublicKey(seed) };
}

/** Sign `message` with an identity's secret key. Returns a 64-byte signature. */
export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretKey.length !== SECRET_LEN) {
    throw cryptoError(`secret key must be ${SECRET_LEN} bytes, got ${secretKey.length}`);
  }
  try {
    return ed25519.sign(message, secretKey);
  } catch (err) {
    throw cryptoError(`sign: ${(err as Error).message}`);
  }
}

/** Verify a 64-byte Ed25519 signature. Returns false on any failure. */
export function verify(publicKey: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}
