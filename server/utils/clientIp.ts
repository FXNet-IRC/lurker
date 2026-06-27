// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// Real-client-IP resolution for WEBIRC forwarding. Lurker connects to IRC
// server-side, so without this every user appears to come from the gateway's one
// IP. We forward the browser's real IP to the IRCd via WEBIRC — but only when we
// can trust the source of that IP.
//
// SECURITY: X-Forwarded-For is client-controllable. We honor it ONLY when
// LURKER_TRUST_PROXY says we sit behind a trusted reverse proxy that overwrites
// it (the FXNet deploy binds 127.0.0.1 behind nginx). Default is OFF, so a
// directly-exposed instance can never be tricked into forwarding a forged IP.

import type { IncomingMessage } from 'http';

/**
 * Parse LURKER_TRUST_PROXY into the value Express `app.set('trust proxy', …)`
 * expects. Unset/empty/false → false (don't trust XFF). 'true' → true.
 * An integer → that hop count. Anything else (e.g. 'loopback', a CIDR, a
 * comma list) is passed through verbatim for Express to interpret.
 */
export function trustProxyConfig(): boolean | number | string {
  const raw = (process.env.LURKER_TRUST_PROXY ?? '').trim();
  if (raw === '') return false;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  if (lower === 'true') return true;
  const n = Number.parseInt(raw, 10);
  if (Number.isInteger(n) && String(n) === raw) return n;
  return raw;
}

/** True when this instance is configured to trust a fronting proxy's XFF. */
export function shouldTrustProxy(): boolean {
  return trustProxyConfig() !== false;
}

/**
 * Strip IPv6-mapped IPv4 (`::ffff:1.2.3.4` → `1.2.3.4`) and surrounding
 * whitespace so the value is a clean IP literal the IRCd can parse in WEBIRC.
 */
export function normalizeIp(ip: string | undefined | null): string {
  const v = (ip ?? '').trim();
  if (!v) return '';
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : v;
}

/**
 * Resolve the real client IP from a raw HTTP request (used by the WS-upgrade
 * handler, which bypasses Express' `trust proxy`). When `trustProxy` is true and
 * an X-Forwarded-For header is present, take its first hop (the original client);
 * otherwise fall back to the socket's peer address. Returns '' when unknown.
 */
export function clientIpFromHeaders(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
      const first = raw.split(',')[0];
      const ip = normalizeIp(first);
      if (ip) return ip;
    }
  }
  return normalizeIp(req.socket?.remoteAddress);
}
