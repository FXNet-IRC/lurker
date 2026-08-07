// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mintProxyToken, verifyProxyToken, resetProxyKeyCache } from './mediaProxyToken.js';

const SAVED = process.env.SESSION_SECRET;

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-for-proxy-tokens';
  resetProxyKeyCache();
});

afterAll(() => {
  if (SAVED === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = SAVED;
  resetProxyKeyCache();
});

describe('proxy tokens', () => {
  it('round-trips a URL', () => {
    const url = 'https://example.com/image.png?a=1&b=2';
    expect(verifyProxyToken(mintProxyToken(url))).toBe(url);
  });

  it('round-trips URLs with characters that need escaping', () => {
    const url = 'https://example.com/(a)/café — ünïcode.png#x';
    expect(verifyProxyToken(mintProxyToken(url))).toBe(url);
  });

  it('is deterministic, so a token caches as a stable identity', () => {
    expect(mintProxyToken('https://e.test/a.png')).toBe(mintProxyToken('https://e.test/a.png'));
  });

  it('rejects a tampered payload', () => {
    const token = mintProxyToken('https://example.com/ok.png');
    const [, sig] = token.split('.');
    const forged = `${Buffer.from('http://169.254.169.254/', 'utf8').toString('base64url')}.${sig}`;
    expect(verifyProxyToken(forged)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = mintProxyToken('https://example.com/ok.png');
    const [payload] = token.split('.');
    expect(verifyProxyToken(`${payload}.notasignature`)).toBeNull();
  });

  it('rejects structurally malformed tokens without throwing', () => {
    for (const bad of ['', '.', 'nodot', '.onlysig', 'a.b.c']) {
      expect(() => verifyProxyToken(bad)).not.toThrow();
      expect(verifyProxyToken(bad)).toBeNull();
    }
  });

  it('rejects a signature that is the right LENGTH but the wrong number of bytes', () => {
    // ⚠⚠ Regression guard. The length guard used `String.length` (UTF-16 code units) while
    // `timingSafeEqual` compares BYTE lengths, so a 43-character signature carrying one
    // multibyte character sailed past the guard and threw `RangeError: Input buffers must have
    // the same byte length` — out of a function whose whole contract is returning null. Express
    // percent-decodes the path parameter, so `%C3%A9` in a URL is enough to reach it: a 500 and
    // a stack trace where a 403 belongs, repeatable at the throttle's full rate.
    const token = mintProxyToken('https://example.com/ok.png');
    const payload = token.slice(0, token.lastIndexOf('.'));
    const realSig = token.slice(token.lastIndexOf('.') + 1);
    const sameLength = `é${'a'.repeat(realSig.length - 1)}`;
    expect(sameLength.length).toBe(realSig.length);
    expect(Buffer.byteLength(sameLength)).not.toBe(Buffer.byteLength(realSig));

    expect(() => verifyProxyToken(`${payload}.${sameLength}`)).not.toThrow();
    expect(verifyProxyToken(`${payload}.${sameLength}`)).toBeNull();
  });

  it('cannot be verified under a different secret', () => {
    // Rotating the session secret invalidates outstanding tokens, which is the
    // intended coupling — a stale token is a re-resolve, not a hole.
    const token = mintProxyToken('https://example.com/a.png');
    process.env.SESSION_SECRET = 'a-completely-different-secret';
    resetProxyKeyCache();
    try {
      expect(verifyProxyToken(token)).toBeNull();
    } finally {
      process.env.SESSION_SECRET = 'test-secret-for-proxy-tokens';
      resetProxyKeyCache();
    }
  });
});
