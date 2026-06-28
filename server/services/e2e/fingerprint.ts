// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Identity fingerprint + human-readable verification string (SAS).
//
// fingerprint = SHA-256("RPE2E01-FP:" || pubkey)[..16]   (domain-separated)
// SAS         = first 6 words of the BIP-39 English mnemonic of those 16 bytes
//
// The domain-separation prefix means the fingerprint is not a raw SHA-256 of
// the key, and the SAS gives users six dictionary words to read aloud when
// verifying a peer out-of-band. Both derivations match repartee exactly.

import { sha256 } from '@noble/hashes/sha2.js';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import { FP_PREFIX } from './constants.js';
import { utf8 } from './encoding.js';

export const FP_LEN = 16;

/** 16-byte truncated, domain-separated SHA-256 of an Ed25519 public key. */
export function fingerprint(pubkey: Uint8Array): Uint8Array {
  const input = new Uint8Array(FP_PREFIX.length + pubkey.length);
  input.set(utf8.encode(FP_PREFIX), 0);
  input.set(pubkey, FP_PREFIX.length);
  return sha256(input).subarray(0, FP_LEN);
}

/** Lowercase-hex rendering of a fingerprint. */
export function fingerprintHex(fp: Uint8Array): string {
  return Buffer.from(fp).toString('hex');
}

/**
 * Six-word BIP-39 SAS for a 16-byte fingerprint. The 16 bytes are encoded as a
 * standard 12-word English mnemonic; we keep the first 6 words for a compact
 * string to read aloud during verification.
 */
export function fingerprintWords(fp: Uint8Array): string {
  const mnemonic = entropyToMnemonic(fp, englishWordlist);
  return mnemonic.split(' ').slice(0, 6).join(' ');
}
