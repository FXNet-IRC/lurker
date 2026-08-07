// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE upload size cap, in one place (#627).
//
// Three ceilings stack, and a client that wants to size media to fit needs the
// smallest of them — not any single one:
//
//   1. MAX_CAP_BYTES     the registry's own hard ceiling; nothing may exceed it.
//   2. transportCapBytes the request-body limit of whatever sits IN FRONT of this
//                        instance. app.lurker.chat is behind Cloudflare, whose
//                        limit is 100 MB on Free/Pro (200 MB on Business); a
//                        larger body dies at the edge with a connection reset the
//                        client sees as an unparseable response, before Express is
//                        ever reached. The server cannot detect this, so the
//                        operator declares it via LURKER_MAX_UPLOAD_MB.
//   3. the per-user cap  the operator-baked uploader policy (hosted locked row),
//                        else the user's own `uploads.image.max_upload_mb`.
//
// Every path that enforces or advertises a size cap goes through here, so
// multer's limit, the handler's 413, and the number we hand clients can never
// disagree. `POST /api/imports` keeps its own much larger limit (an archive isn't
// something a client sizes media against) but borrows the transport ceiling via
// clampToTransport — see #649.
//
// Bytes, not MB, is the canonical unit: it's what multer takes, what a client
// compares a file size against, and the only unit in which the transport
// ceiling's headroom below can be expressed honestly.

import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { resolveUploader } from './uploadProviders/resolve.js';

/** The registry's own ceiling; a per-user cap can't exceed it, so neither can multer. */
export const MAX_CAP_MB = 200;
export const MAX_CAP_BYTES = MAX_CAP_MB * 1024 * 1024;

// What the multipart envelope costs on top of the file itself: the boundary
// lines, each part's Content-Disposition/Content-Type headers, and the
// `uploaderId` / `progressToken` text fields. A proxy limit applies to the whole
// REQUEST BODY, but multer's fileSize limit — and the number we advertise —
// describe the FILE part alone, so the difference has to come off the top.
// Without it a client that does exactly what the docs tell it (compress to
// maxUploadBytes) ships a body just over the proxy's limit and gets the edge
// reset this whole feature exists to prevent. 64 KiB is far more than the few
// hundred bytes actually needed; the slack is free and covers future fields.
const ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/** Resolve effective settings with registry defaults filled in. The per-user
 *  image-pipeline settings (size cap, max dimension, JPEG quality) are the
 *  fallback used when the resolved uploader carries no operator-baked policy caps
 *  — i.e. every self-host uploader. Untyped (JS module) → Record<string, unknown>. */
export function effectiveSettings(userId: number): Record<string, unknown> {
  return { ...defaultsAsObject(), ...getUserSettings(userId) };
}

/** The user's size cap, in bytes. effectiveSettings() has already merged the
 *  registry default in, so this reads it from ONE place — a second hardcoded
 *  default here would be a duplicate that quietly disagrees the next time the
 *  registry changes. MiB, matching the registry setting's own units. */
export function userCapBytes(settings: Record<string, unknown>): number {
  const n = Number(settings['uploads.image.max_upload_mb']);
  return Number.isFinite(n) && n > 0 ? n * 1024 * 1024 : MAX_CAP_BYTES;
}

// Warn once per process, not per upload: transportCapBytes() runs on every
// snapshot and every upload, and a misconfiguration that repeats a thousand
// times a minute is noise rather than a signal.
let warnedBadTransportCap = false;

/**
 * What the operator DECLARED, in bytes, or null when they declared nothing —
 * the self-hoster with no proxy in front of them. Not clamped to any upload
 * ceiling: a caller with its own, larger limit (`POST /api/imports` allows
 * 500 MB) needs the raw declaration, and would silently lose 300 MB of headroom
 * if "unset" were reported as the upload path's 200 MB hard cap.
 *
 * Deliberately an env var rather than a tenant setting, for the same reason the
 * node-edition pipeline knobs are: it describes the deployment, not a preference,
 * and a tenant must not be able to raise it.
 *
 * The declared MB is read as DECIMAL (10⁶), unlike the per-user setting's MiB.
 * Proxies disagree — Cloudflare documents decimal MB, nginx's `client_max_body_size
 * 100m` is 100 MiB — and the decimal reading is the smaller of the two, so it is
 * the safe one when the proxy's own unit is unknown. Erring 4.8% low costs a
 * self-hoster nothing; erring high is the edge reset again.
 */
export function declaredTransportCapBytes(): number | null {
  const raw = (process.env.LURKER_MAX_UPLOAD_MB || '').trim();
  if (!raw) return null;
  const mb = Math.floor(Number(raw));
  if (!Number.isFinite(mb) || mb <= 0) {
    // "100MB" / "100m" — the natural typo, given the var is named _MB — parses to
    // NaN. Falling back to no-ceiling is the right direction (a typo must never
    // refuse every upload on the instance), but silently doing so would leave the
    // operator looking at a setting that never took effect while uploads keep
    // dying at the edge. Say so.
    if (!warnedBadTransportCap) {
      warnedBadTransportCap = true;
      console.warn(
        `[lurker] LURKER_MAX_UPLOAD_MB="${raw}" is not a positive whole number of ` +
          'megabytes; ignoring it. Uploads are NOT bounded by a transport ceiling. ' +
          'Use a bare integer, e.g. LURKER_MAX_UPLOAD_MB=100.',
      );
    }
    return null;
  }
  return mb * 1_000_000 - ENVELOPE_HEADROOM_BYTES;
}

/** The transport ceiling as the UPLOAD path sees it: the declaration, else no
 *  extra ceiling beyond the hard cap. */
export function transportCapBytes(): number {
  return Math.min(declaredTransportCapBytes() ?? MAX_CAP_BYTES, MAX_CAP_BYTES);
}

/**
 * Apply the transport ceiling to a caller that has its OWN limit — currently the
 * import route's 500 MB. Nothing here involves the upload hard cap or a user's
 * preference; it answers only "can a body this big reach us at all".
 */
export function clampToTransport(ownLimitBytes: number): number {
  const declared = declaredTransportCapBytes();
  return declared == null ? ownLimitBytes : Math.max(1, Math.min(ownLimitBytes, declared));
}

/** Clamp a candidate cap to the instance-wide ceilings. Floors at 1 byte so no
 *  configuration can resolve to a negative or zero cap; a genuinely tiny value is
 *  the operator's own declaration and is reported honestly rather than rounded up
 *  past the limit they set. */
export function clampUploadCapBytes(bytes: number): number {
  return Math.max(1, Math.min(bytes, transportCapBytes(), MAX_CAP_BYTES));
}

/**
 * The effective cap for this user, in bytes — what a client should size media to
 * fit and what the server will actually accept. Resolves the user's DEFAULT
 * uploader: a per-upload `uploaderId` override with a tighter policy cap is caught
 * by the handler's own re-check, which is the number that ends up in the 413.
 *
 * An unusable uploader is not an error here. "How big may I upload" has an answer
 * even when the answer to "where does it go" is currently 400/503 — reporting the
 * user's own clamped cap keeps this from being a second failure surface.
 */
export function effectiveUploadCapBytes(userId: number, isAdmin: boolean): number {
  const fallback = userCapBytes(effectiveSettings(userId));
  let cap = fallback;
  try {
    const policyMb = resolveUploader({ userId, isAdmin, requestedId: null }).policy.maxMb;
    cap = policyMb == null ? fallback : policyMb * 1024 * 1024;
  } catch {
    // No usable uploader configured — fall through to the user's own cap.
  }
  return clampUploadCapBytes(cap);
}

/** The cap as a human-readable MB string for the 413 body. At most one decimal,
 *  because the transport ceiling's headroom makes a whole number a lie: telling a
 *  user their file "exceeds 1 MB" when the real limit is 0.9 MB sends them back
 *  with another file that fails. */
export function formatCapMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return (mb >= 10 ? Math.floor(mb) : Math.floor(mb * 10) / 10).toString();
}
