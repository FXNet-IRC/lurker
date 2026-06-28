// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';

import {
  deriveWrapKey,
  ed25519PubToX25519,
  ed25519SeedToX25519,
  generateEphemeral,
  WRAP_KEY_LEN,
} from './ecdh.js';
import { identityFromSeed } from './identity.js';

const enc = new TextEncoder();
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

describe('ecdh wrap-key derivation', () => {
  it('both sides derive the same 32-byte wrap key', () => {
    const alice = generateEphemeral();
    const bob = generateEphemeral();
    const info = enc.encode('test-context');
    const kAB = deriveWrapKey(alice.secretKey, bob.publicKey, info);
    const kBA = deriveWrapKey(bob.secretKey, alice.publicKey, info);
    expect(kAB).toEqual(kBA);
    expect(kAB.length).toBe(WRAP_KEY_LEN);
  });

  it('different info strings yield different keys', () => {
    const alice = generateEphemeral();
    const bob = generateEphemeral();
    const k1 = deriveWrapKey(alice.secretKey, bob.publicKey, enc.encode('ctx-1'));
    const k2 = deriveWrapKey(alice.secretKey, bob.publicKey, enc.encode('ctx-2'));
    expect(k1).not.toEqual(k2);
  });

  it('surfaces an invalid (all-zero / small-order) peer public as an E2eError', () => {
    const me = generateEphemeral();
    expect(() => deriveWrapKey(me.secretKey, new Uint8Array(32), enc.encode('ctx'))).toThrow(
      /derive wrap key/,
    );
  });

  it('surfaces an invalid Ed25519 point as an E2eError', () => {
    expect(() => ed25519PubToX25519(new Uint8Array(32).fill(0xff))).toThrow(/invalid ed25519 pub/);
  });
});

// RFC 8032 section 7.1 seeds, also used by ed25519-dalek's tests and by
// repartee's ecdh.rs::ed25519_to_x25519_rfc8032_vectors. Asserting these
// guarantees byte-for-byte agreement with libsodium-based peers (the
// Perl/Python scripts) on the Ed25519 -> X25519 birational map.
describe('Ed25519 -> X25519 conversion (RFC 8032 vectors)', () => {
  const seedA = hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const seedB = hex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
  const pubA = hex('d85e07ec22b0ad881537c2f44d662d1a143cf830c57aca4305d85c7a90f6b62e');
  const pubB = hex('25c704c594b88afc00a76b69d1ed2b984d7e22550f3ed0802d04fbcd07d38d47');
  const shared = hex('5166f24a6918368e2af831a4affadd97af0ac326bdf143596c045967cc00230e');

  it('derives the known X25519 public from the Ed25519 seed (secret side)', () => {
    expect(x25519.getPublicKey(ed25519SeedToX25519(seedA))).toEqual(pubA);
    expect(x25519.getPublicKey(ed25519SeedToX25519(seedB))).toEqual(pubB);
  });

  it('derives the known X25519 public from the Ed25519 public (point side)', () => {
    const edPubA = identityFromSeed(seedA).publicKey;
    const edPubB = identityFromSeed(seedB).publicKey;
    expect(ed25519PubToX25519(edPubA)).toEqual(pubA);
    expect(ed25519PubToX25519(edPubB)).toEqual(pubB);
  });

  it('reaches the RFC shared secret from both directions', () => {
    const scalarA = ed25519SeedToX25519(seedA);
    const scalarB = ed25519SeedToX25519(seedB);
    expect(x25519.getSharedSecret(scalarA, pubB)).toEqual(shared);
    expect(x25519.getSharedSecret(scalarB, pubA)).toEqual(shared);
  });
});
