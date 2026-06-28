// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';

import { fingerprint, fingerprintHex, fingerprintWords, FP_LEN } from './fingerprint.js';

describe('fingerprint', () => {
  it('is 16 bytes', () => {
    expect(fingerprint(new Uint8Array(32)).length).toBe(FP_LEN);
  });

  it('is deterministic', () => {
    const pk = new Uint8Array(32).fill(42);
    expect(fingerprint(pk)).toEqual(fingerprint(pk));
  });

  it('is domain-separated (not a raw SHA-256 of the key)', () => {
    const pk = new Uint8Array(32).fill(7);
    const raw = sha256(pk).subarray(0, 16);
    expect(fingerprint(pk)).not.toEqual(raw);
  });

  it('renders lowercase hex', () => {
    expect(fingerprintHex(new Uint8Array([0xab, 0xcd]))).toBe('abcd');
  });
});

describe('fingerprintWords (BIP-39 SAS)', () => {
  it('produces exactly 6 words', () => {
    expect(fingerprintWords(new Uint8Array(16).fill(0xab)).split(' ').length).toBe(6);
  });

  it('is deterministic', () => {
    const fp = new Uint8Array(16).fill(0xcd);
    expect(fingerprintWords(fp)).toBe(fingerprintWords(fp));
  });

  // BIP-39 known-answer test: 16 zero bytes is the canonical all-zero entropy
  // whose English mnemonic begins "abandon abandon ... about". This pins our
  // wordlist + checksum to the standard, hence to repartee's bip39 crate.
  it('matches the BIP-39 standard wordlist (zero-entropy KAT)', () => {
    expect(fingerprintWords(new Uint8Array(16))).toBe(
      'abandon abandon abandon abandon abandon abandon',
    );
  });
});
