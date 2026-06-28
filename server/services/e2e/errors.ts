// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Error taxonomy for the RPE2E crypto core. Mirrors the variants of
// repartee's `E2eError` (Rust) so failures map cleanly across the two
// implementations and callers can branch on `kind` without string-matching.

export type E2eErrorKind = 'wire' | 'handshake' | 'crypto' | 'chunk-limit' | 'keyring';

export class E2eError extends Error {
  readonly kind: E2eErrorKind;

  constructor(kind: E2eErrorKind, message: string) {
    super(message);
    this.name = 'E2eError';
    this.kind = kind;
  }
}

export const wireError = (msg: string): E2eError => new E2eError('wire', msg);
export const handshakeError = (msg: string): E2eError => new E2eError('handshake', msg);
export const cryptoError = (msg: string): E2eError => new E2eError('crypto', msg);
export const chunkLimitError = (count: number): E2eError =>
  new E2eError('chunk-limit', `too many chunks: ${count}`);
