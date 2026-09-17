// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The bouncer's own environment, read on demand. Kept out of services/bouncer.ts
// so that asking "does this instance run a bouncer?" — which the public
// /api/config answers on every boot — doesn't drag the bouncer, ircManager and
// the database in behind it.

export function isBouncerEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LURKER_BOUNCER_ENABLED || '').trim());
}

export function bouncerPort(): number {
  const p = Number(process.env.LURKER_BOUNCER_PORT);
  return Number.isInteger(p) && p > 0 ? p : 6667;
}

// Optional bind address (LURKER_BOUNCER_BIND). Unset binds every interface —
// pair the default with TLS or a private network; plain-text IRC carries the
// login credential.
export function bouncerBindHost(): string | undefined {
  const host = (process.env.LURKER_BOUNCER_BIND || '').trim();
  return host || undefined;
}

/** What to tell people to connect to, when it isn't what the bouncer binds.
 *  `LURKER_BOUNCER_PUBLIC_URL=ircs://irc.example.com:6697` — `ircs` for TLS,
 *  `irc` without. Null when unset or unusable. */
export function bouncerPublicAddress(): { host: string; port: number; tls: boolean } | null {
  const raw = (process.env.LURKER_BOUNCER_PUBLIC_URL || '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warnPublicUrl(raw);
    return null;
  }
  const tls = url.protocol === 'ircs:';
  if ((!tls && url.protocol !== 'irc:') || !url.hostname || url.pathname.replace(/\/+$/, '')) {
    warnPublicUrl(raw);
    return null;
  }
  const port = url.port ? Number(url.port) : bouncerPort();
  if (!Number.isInteger(port) || port <= 0) {
    warnPublicUrl(raw);
    return null;
  }
  // url.hostname keeps an IPv6 literal's brackets; an IRC client's server field
  // wants the address itself.
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, tls };
}

let warnedPublicUrl = false;
function warnPublicUrl(raw: string): void {
  if (warnedPublicUrl) return;
  warnedPublicUrl = true;
  console.warn(
    `[lurker] LURKER_BOUNCER_PUBLIC_URL is not a usable IRC address (${raw}); ` +
      'expected ircs://host[:port] or irc://host[:port]. Settings will show this ' +
      "instance's own hostname and port instead.",
  );
}

// The certificate the listener is serving, published by startBouncer. Held here
// rather than in the service so Settings can ask what a client will be shown
// without loading the bouncer runtime behind the question.
let tlsState: { selfSigned: boolean; fingerprint: string } | null = null;

/** Called by the listener as it comes up, and with null when it isn't doing TLS. */
export function setBouncerTlsState(state: { selfSigned: boolean; fingerprint: string } | null) {
  tlsState = state;
}

/** What the listener serves, for Settings → Bouncer. A self-signed certificate
 *  is the default, and the first connection fails on it unless the member knows
 *  to accept it — so the pane says so, with the fingerprint to check against.
 *  Null when the bouncer isn't listening, or isn't the one doing TLS. */
export function bouncerTlsInfo(): { selfSigned: boolean; fingerprint: string } | null {
  return tlsState;
}

/** Whether the bouncer terminates TLS itself. An operator may terminate it in
 *  front instead, which is what LURKER_BOUNCER_PUBLIC_URL is for. */
export function bouncerTerminatesTls(): boolean {
  return !bouncerTlsDisabled();
}

// Plaintext IRC ships the login credential in the clear, so TLS is the default.
// Only an explicit LURKER_BOUNCER_TLS=off (0/false/no/off) turns it off.
export function bouncerTlsDisabled(): boolean {
  return /^(0|false|no|off)$/i.test((process.env.LURKER_BOUNCER_TLS || '').trim());
}
