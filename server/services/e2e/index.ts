// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// RPE2E — Repartee End-to-End encryption (v1.0), crypto core.
//
// A byte-compatible TypeScript port of repartee's RPE2E01 protocol primitives:
// Ed25519 identities (TOFU-pinned), X25519 ECDH key-wrap, XChaCha20-Poly1305
// message encryption, and the signed CTCP-NOTICE handshake codec. This module
// is pure crypto + wire format — no IRC, DB, or UI wiring. See issue #382.
//
// Interop notes (load-bearing — see the per-module sources):
//  - message wire format uses STANDARD base64; handshakes use URL-safe-no-pad.
//  - AAD is length-prefixed big-endian; golden vector pinned in aad.test.ts.
//  - HKDF-SHA256 salt is the constant "RPE2E01-WRAP".

export * from './constants.js';
export * from './errors.js';
export * from './aad.js';
export * from './aead.js';
export * from './wire.js';
export * from './chunker.js';
export * from './identity.js';
export * from './fingerprint.js';
export * from './ecdh.js';
export * from './handshake.js';
export * from './context.js';
