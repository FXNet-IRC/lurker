// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// How the preview byte cache is configured, and the one place that decides
// whether it is on at all.
//
// ⚠ ENV, not instance settings, and that is a deliberate deviation from #681.
// That issue asks for `previews.cache.mode` in `instance_settings` with an admin
// form beside the uploader config, which is the right long-term surface. Every
// other operator-level knob this app has — LURKER_LINK_PREVIEWS,
// LURKER_SECRET_KEY, DATABASE_PATH — is already an env var, so this matches what
// a self-hoster is already doing. `resolveCacheConfig` is the seam the admin
// surface slots into; nothing above this module knows where the values came from.
//
// ⚠ "It would need somewhere to keep a secret" is NOT one of the reasons, and is
// worth naming so nobody adds it: `uploader_config` already stores S3 credentials
// encrypted behind a generic admin form, and `local` has no secret at all. The
// reason is the one above — this knob's neighbours are env vars.

import crypto from 'crypto';
import path from 'path';
import { resolveDataDir } from '../../utils/dataDir.js';
import { sanitizeSegment } from '../uploadProviders/s3.js';

export type CacheMode = 'off' | 'local' | 's3';

export interface LocalCacheConfig {
  mode: 'local';
  dir: string;
  /** Ceiling for the cache directory. Eviction runs BEFORE a write that would exceed it. */
  maxBytes: number;
}

export interface S3CacheConfig {
  mode: 's3';
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where readers are sent. Public by construction — that is the point of the mode. */
  publicBaseUrl: string;
  /** Already sanitised and slash-trimmed; may be empty. */
  prefix: string;
  /**
   * Where bytes are staged on their way to the bucket.
   *
   * ⚠ A file, not a heap buffer, and not optional. SigV4 must hash the payload
   * before it can sign, so the bytes are read twice — and the route streams them
   * in chunk by chunk. Collecting them in memory would cost the per-request 8 MB
   * image ceiling times `mediaPool`'s 24 slots, and worse, an un-awaited store
   * outlives its pool slot, so nothing bounds how many accumulate. Same reasoning
   * as `local`'s writer, which this reuses.
   */
  stagingDir: string;
}

export type CacheConfig = { mode: 'off' } | LocalCacheConfig | S3CacheConfig;

/** 2 GiB. Big enough that a normal instance never evicts, small enough to notice. */
const DEFAULT_LOCAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * ⚠ Misconfiguration resolves to `off`, and says so once, rather than throwing.
 *
 * This is a cache. A bad value is a reason to stop caching, never a reason for a
 * server not to boot or for a link preview to stop rendering — the uncached path
 * is a complete, working feature, which is what makes failing soft right here and
 * wrong for, say, a database path.
 */
export function resolveCacheConfig(warn: (msg: string) => void = defaultWarn): CacheConfig {
  const mode = env('LURKER_PREVIEW_CACHE_MODE').toLowerCase();
  if (mode === '' || mode === 'off') return { mode: 'off' };

  if (mode === 'local') {
    const raw = env('LURKER_PREVIEW_CACHE_MAX_BYTES');
    // ⚠ Digits only, and a SAFE integer. `parseInt` would take '2GB' and hand back
    // 2 — a two-byte cache that evicts everything it stores and reads as "caching
    // is broken". The upper bound matters for the same reason in the other
    // direction: past MAX_SAFE_INTEGER the eviction arithmetic stops being exact,
    // and a silently wrong answer about whether we are over the ceiling is worse
    // than refusing the value.
    const parsed = /^\d{1,19}$/.test(raw) ? Number(raw) : Number.NaN;
    const usable = Number.isSafeInteger(parsed) && parsed > 0;
    if (raw !== '' && !usable) {
      warn(
        `[preview-cache] LURKER_PREVIEW_CACHE_MAX_BYTES="${raw}" is not a usable byte count — ` +
          `falling back to ${DEFAULT_LOCAL_MAX_BYTES}.`,
      );
    }
    return {
      mode: 'local',
      dir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
      maxBytes: usable ? parsed : DEFAULT_LOCAL_MAX_BYTES,
    };
  }

  if (mode === 's3') return resolveS3(warn);

  warn(`[preview-cache] unknown LURKER_PREVIEW_CACHE_MODE "${mode}" — caching is OFF.`);
  return { mode: 'off' };
}

/**
 * The bucket backend.
 *
 * ⚠⚠ Unlike `local`, the objects this writes are read DIRECTLY by browsers — the
 * descriptor hands out `publicBaseUrl` rather than a proxy path once an object is
 * known to exist. That is what makes the mode worth having (the cell ships zero
 * bytes for a cached image) and it is also why every field below is validated
 * rather than merely read: a half-configured bucket here does not degrade to slow,
 * it degrades to a public URL that 404s for everyone.
 */
function resolveS3(warn: (msg: string) => void): CacheConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env(name);
    if (!value) missing.push(name);
    return value;
  };
  const endpoint = required('LURKER_PREVIEW_CACHE_S3_ENDPOINT');
  const bucket = required('LURKER_PREVIEW_CACHE_S3_BUCKET');
  const accessKeyId = required('LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY');
  const publicBaseUrl = required('LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL');

  if (missing.length) {
    warn(`[preview-cache] mode "s3" needs ${missing.join(', ')} — caching is OFF.`);
    return { mode: 'off' };
  }

  // ⚠⚠ https, not merely a valid URL. These URLs are handed to browsers as image
  // sources on a page served over https, where an http:// image is blocked as
  // mixed content and simply never renders. Refusing here makes that a warning at
  // boot instead of every cached preview silently going blank.
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    warn(`[preview-cache] S3_PUBLIC_BASE_URL "${publicBaseUrl}" is not a URL — caching is OFF.`);
    return { mode: 'off' };
  }
  if (base.protocol !== 'https:') {
    warn(
      `[preview-cache] S3_PUBLIC_BASE_URL must be https (got "${base.protocol}") — caching is OFF.`,
    );
    return { mode: 'off' };
  }

  // ⚠ SANITISED, per segment, with the uploader's own function. An operator's
  // prefix reaches `new URL()` and an S3 key; left raw, a '#' in it truncates the
  // signed URL at the fragment so EVERY object PUTs to one key and one person's
  // picture serves under another's. The alphabet is the same URL-unreserved set
  // the uploader's keys use, which is what lets both sides skip percent-encoding
  // and sidesteps the classic SigV4 encoding mismatch.
  const prefix = env('LURKER_PREVIEW_CACHE_S3_PREFIX')
    .split('/')
    .map(sanitizeSegment)
    .filter((part) => part && !/^\.+$/.test(part))
    .join('/');

  return {
    mode: 's3',
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    // R2 wants literally "auto"; MinIO accepts any region. Matches the uploader.
    region: env('LURKER_PREVIEW_CACHE_S3_REGION') || 'auto',
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    prefix,
    stagingDir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
  };
}

function defaultWarn(msg: string): void {
  console.warn(msg);
}

/**
 * How long a cached object may be served before it is re-fetched.
 *
 * ⚠ Deliberately the same seven days as `link_previews`' OK_TTL. The two caches
 * describe the same URL, and letting the bytes outlive the metadata means an image
 * that changed at a stable address — an avatar, a `latest.png` — is served from
 * disk long after the record for it was re-resolved. Eviction is by PRESSURE, so
 * without an age bound the staleness window is unbounded; before this cache
 * existed it was a day.
 *
 * ⚠⚠ For `s3` it is also a CORRECTNESS bound, not a freshness one. Objects there
 * are deleted by a bucket lifecycle rule the cell does not run and cannot observe
 * (30 days, per LINK_PREVIEWS_CACHE_PLAN.md), and a row that outlived its object
 * would have `publicByteUrl` mint a public URL that 404s for every user with no
 * request reaching us to notice. Seven against thirty is the margin that makes the
 * row provably the shorter-lived of the two.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Past the age bound, and therefore not to be served or minted. */
export function expired(createdAt: string): boolean {
  return Date.now() - Date.parse(createdAt) > MAX_AGE_MS;
}

/**
 * The cache key for one URL's BYTES.
 *
 * ⚠⚠ Its own digest, deliberately NOT `db/linkPreviews.ts`'s `urlHash`. That one
 * folds in `RESOLVER_VERSION`, a counter whose entire job is to invalidate
 * METADATA when the resolver would produce a different record — it has already
 * been bumped for a WebP/GIF *dimension* change, and its docblock actively invites
 * more. Sharing it would mean a routine metadata bump silently discards every
 * cached byte on the instance and re-fetches every image at once, from a diff that
 * never mentions this module and a reviewer who has no reason to look here. The
 * identity of a cached picture is its URL, and nothing else.
 *
 * ⚠ Canonicalised the way `urlHash` does — fragment stripped — so `#a` and `#b` of
 * one image share an object rather than being fetched and stored twice.
 */
export function byteCacheKey(url: string): string {
  let key: string;
  try {
    const canonical = new URL(url);
    canonical.hash = '';
    key = canonical.toString();
  } catch {
    key = url.replace(/#[\s\S]*$/, '');
  }
  return crypto.createHash('sha256').update(`bytes-v1|${key}`).digest('hex');
}

/**
 * ⚠ Resolved ONCE per process, not per request.
 *
 * The config comes from the environment, which cannot change under a running
 * process, and re-reading it per byte request would re-run the validation — and
 * re-log its warnings — on the hottest path this feature has.
 */
let memoised: CacheConfig | null = null;

export function cacheConfig(): CacheConfig {
  memoised ??= resolveCacheConfig();
  return memoised;
}

/** Test seam: drop the memoised config so the next call re-reads the environment. */
export function resetCacheConfigForTests(): void {
  memoised = null;
}

export function cacheEnabled(): boolean {
  return cacheConfig().mode !== 'off';
}
