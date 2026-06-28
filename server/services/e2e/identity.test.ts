// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import {
  generateIdentity,
  identityFromSeed,
  PUBLIC_LEN,
  SECRET_LEN,
  sign,
  verify,
} from './identity.js';

const enc = new TextEncoder();

describe('identity (Ed25519)', () => {
  it('generates 32-byte secret and public keys', () => {
    const id = generateIdentity();
    expect(id.secretKey.length).toBe(SECRET_LEN);
    expect(id.publicKey.length).toBe(PUBLIC_LEN);
  });

  it('derives a deterministic public key from a seed', () => {
    const seed = new Uint8Array(32).fill(7);
    expect(identityFromSeed(seed).publicKey).toEqual(identityFromSeed(seed).publicKey);
  });

  it('produces distinct public keys for distinct seeds', () => {
    const a = identityFromSeed(new Uint8Array(32).fill(1));
    const b = identityFromSeed(new Uint8Array(32).fill(2));
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('signs and verifies a round-trip', () => {
    const id = generateIdentity();
    const msg = enc.encode('handshake payload');
    expect(verify(id.publicKey, msg, sign(id.secretKey, msg))).toBe(true);
  });

  it('rejects a tampered message', () => {
    const id = generateIdentity();
    const sig = sign(id.secretKey, enc.encode('orig'));
    expect(verify(id.publicKey, enc.encode('tampered'), sig)).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const sig = sign(a.secretKey, enc.encode('msg'));
    expect(verify(b.publicKey, enc.encode('msg'), sig)).toBe(false);
  });
});
