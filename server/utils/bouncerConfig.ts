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
  return { host: url.hostname, port, tls };
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
