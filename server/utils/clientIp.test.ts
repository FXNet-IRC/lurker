// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';
import {
  trustProxyConfig,
  shouldTrustProxy,
  normalizeIp,
  clientIpFromHeaders,
} from './clientIp.js';

function req(headers: Record<string, string | string[]>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

const ORIGINAL = process.env.LURKER_TRUST_PROXY;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LURKER_TRUST_PROXY;
  else process.env.LURKER_TRUST_PROXY = ORIGINAL;
});

describe('trustProxyConfig', () => {
  it('defaults to false when unset', () => {
    delete process.env.LURKER_TRUST_PROXY;
    expect(trustProxyConfig()).toBe(false);
    expect(shouldTrustProxy()).toBe(false);
  });

  it('treats explicit falsey values as false', () => {
    for (const v of ['false', '0', 'no', '']) {
      process.env.LURKER_TRUST_PROXY = v;
      expect(trustProxyConfig()).toBe(false);
    }
  });

  it('maps true and integer hop counts', () => {
    process.env.LURKER_TRUST_PROXY = 'true';
    expect(trustProxyConfig()).toBe(true);
    process.env.LURKER_TRUST_PROXY = '2';
    expect(trustProxyConfig()).toBe(2);
  });

  it('passes through named/CIDR values verbatim', () => {
    process.env.LURKER_TRUST_PROXY = 'loopback';
    expect(trustProxyConfig()).toBe('loopback');
    expect(shouldTrustProxy()).toBe(true);
  });
});

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
  it('trims and passes through plain addresses', () => {
    expect(normalizeIp('  198.51.100.2 ')).toBe('198.51.100.2');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
  it('returns empty for nullish', () => {
    expect(normalizeIp(undefined)).toBe('');
    expect(normalizeIp(null)).toBe('');
  });
});

describe('clientIpFromHeaders', () => {
  it('uses the socket address when not trusting a proxy', () => {
    const r = req({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
    expect(clientIpFromHeaders(r, false)).toBe('10.0.0.9');
  });

  it('takes the first XFF hop when trusting a proxy', () => {
    const r = req({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, '127.0.0.1');
    expect(clientIpFromHeaders(r, true)).toBe('203.0.113.5');
  });

  it('falls back to the socket when trusted but no XFF present', () => {
    const r = req({}, '::ffff:203.0.113.9');
    expect(clientIpFromHeaders(r, true)).toBe('203.0.113.9');
  });

  it('never honors a forged XFF when proxy is untrusted', () => {
    const r = req({ 'x-forwarded-for': '6.6.6.6' }, '198.51.100.10');
    expect(clientIpFromHeaders(r, false)).toBe('198.51.100.10');
  });
});
