// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The bucket backend. Objects are PUT with SigV4 and then read DIRECTLY by
// browsers from the bucket's public base URL — the descriptor hands out that URL
// instead of a proxy path once an object is known to exist, so the cell ships
// zero bytes for a cached image. `publicByteUrl` below is where that decision is
// made; it lives here rather than in ./index.ts because the resolver has to call
// it, and ./index.ts imports the resolver.
//
// ⚠ Reuses the UPLOADER's `signObjectRequest`, `hashOf` and `putSource` rather
// than the provider interface, and that is the shape #681 asks for: the interface
// fits neither side of this problem. `dropper` (the hosted driver) declares
// `mintsKeys: false`, and a cache entry has to be addressable by a key derived
// from its URL; `local` and `s3` are both `selfHostOnly`, so the abstraction is
// never offered where the hosted case needs it. The SIGNING and the TRANSPORT are
// the reusable parts, and both are already exported.
//
// ⚠⚠ WHAT A PUBLIC OBJECT CAN AND CANNOT CARRY. The proxy sets six response
// headers on every byte answer (`applyMediaHeaders`). An S3 object can only store
// and replay a fixed few — Content-Type, Content-Disposition, Cache-Control — so
// three of them are simply not expressible here:
//
//   stored:      Content-Type, Content-Disposition: inline, Cache-Control
//   NOT stored:  X-Content-Type-Options: nosniff
//                Content-Security-Policy: default-src 'none'; sandbox
//                Cross-Origin-Resource-Policy
//
// This is a property of object storage, not of this code, and it is NOT fixed by
// serving via a redirect either — headers on a 302 do not apply to its target.
// The only design where all six survive is proxying the bytes, which is what
// `local` does and what this mode exists to avoid.
//
// Taken one at a time, because they are NOT equally missed:
//
//   - CORP costs NOTHING, and calling it a concession was wrong. Its job is
//     keeping a resource out of a hostile page's process (the Spectre-era
//     COOP/COEP family); these objects are deliberately public, so there is
//     nothing to isolate. And the proxy's own value, `same-origin`, would BREAK a
//     CDN object — a page on the app origin embedding one is cross-origin by
//     definition. The only workable value on a separate host is `cross-origin`,
//     which is the permissive default. We could not have used it if we could set
//     it.
//   - `nosniff` is a SMALL loss. It matters most when the type is absent or
//     generic (`text/plain`, `application/octet-stream`); a concrete `image/*` is
//     stored here, and browsers do not sniff a document out of a declared image
//     type on a top-level navigation. For an `<img>` load it is irrelevant
//     either way — the decoder goes by magic bytes and a non-image just fails.
//   - The CSP `sandbox` is the REAL loss of the three, and only for someone
//     navigating DIRECTLY to an object URL: it forces an opaque origin with no
//     script execution, so bytes a browser did decide to treat as a document
//     stay inert. CSP on a subresource is otherwise ignored.
//
// ⚠⚠ AND THE THING THAT ACTUALLY BOUNDS THIS IS NOT A HEADER. All three only
// matter if non-image bytes can be stored under an image content type — and today
// they can: `kindForContentType` tests the DECLARED type
// (`contentType.startsWith('image/')`, with `image/svg+xml` refused) and nothing
// on the byte path inspects the body. An origin under an attacker's control
// serves `Content-Type: image/png` with an HTML body, and we cache it verbatim;
// the URL is minted to their own client, so they can hand it to anyone.
//
// ⚠ An earlier version of this comment claimed the stored `Content-Type` was
// "set from the type we validated rather than from anything the origin asserted
// unchecked". That was not true — the allowlist validates the origin's CLAIM, not
// the bytes — and it is the sort of false reassurance that stops the next person
// looking. Validating the bytes at store time removes the whole class for every
// backend at once, which is the right altitude and is tracked separately; until
// then this is a real, if narrow, residual: content on the CDN origin rather than
// the app origin, and Lurker's session cookie is host-only, so it is not a
// session-theft path.
//
// An operator who wants the other two can add them at the CDN edge (Cloudflare
// Transform Rules and equivalents do this), which is a deployment choice we can
// document but cannot enforce from here.

import fs from 'fs/promises';
import { peekCached } from '../../db/previewCache.js';
import { fileSource, hashOf } from '../uploadProviders/source.js';
import { putSource } from '../uploadProviders/multipart.js';
import { signObjectRequest } from '../uploadProviders/s3.js';
import { openTempFile } from './tempFile.js';
import { byteCacheKey, cacheConfig, expired, type S3CacheConfig } from './config.js';

/**
 * What a CACHED object advertises to the browsers that read it directly.
 *
 * ⚠ Not the uploader's year of `immutable`, and not `public` either. A day
 * matches what the proxy has always sent for the same bytes, so turning this mode
 * on does not change how long a client holds an image. Bounded freshness also
 * means deleting an object actually un-serves it within a day — with a year at
 * the edge, a takedown would delete the origin copy and change nothing.
 */
const OBJECT_CACHE_CONTROL = 'public, max-age=86400';

/** No filename: it would come from a URL someone else controls. Same value the
 *  proxy sends, and one of the three that object storage will actually replay. */
const OBJECT_CONTENT_DISPOSITION = 'inline';

/**
 * Stores whose bytes are still moving — staged, hashing, or mid-PUT.
 *
 * ⚠ Module state rather than a field on the config, because the config is a plain
 * value that is re-resolved by tests and the bound has to survive that. One
 * process, one bucket, one ceiling.
 */
let storesInFlight = 0;
/** Generous next to `mediaPool`'s 24, because these are meant to be short — the
 *  ceiling is a backstop against a stalled bucket, not a throughput knob. */
const MAX_STORES_IN_FLIGHT = 16;

/** Test seam: the bound is invisible from outside until it bites. */
export function storesInFlightForTests(): number {
  return storesInFlight;
}

/**
 * ⚠ A cache is not a failure path, but a cache that fails FOREVER and SILENTLY is
 * an operator support burden. Config validation only proves the five env vars are
 * present — a wrong secret, a bucket policy denial, a typo'd bucket name or a
 * scheme-less endpoint all resolve to a working-looking `s3` mode where every
 * store fails, nothing populates, and no line is ever logged. `local` at least
 * leaves errno-shaped evidence on the volume.
 *
 * ⚠ Throttled to once a minute, and deliberately not per-key: the failure mode
 * this exists for is EVERY store failing, so an unthrottled warning would be one
 * line per image request in the log of a server that is otherwise fine.
 */
let lastWarnAt = 0;

/** Test seam: the throttle is global, so one test warning silences the next. */
export function resetWarnThrottleForTests(): void {
  lastWarnAt = 0;
}

function warnOnce(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[preview-cache] ${message}`);
}

/**
 * Let go of a response we are not going to read.
 *
 * ⚠⚠ CANCEL, never `res.text()`. Undici keeps the connection alive for an unread
 * body, so it does have to be dealt with — but reading it to discard it buffers
 * the whole thing, which is unbounded by protocol on an error path and is
 * precisely backwards in the oversize branch, where the guard would announce that
 * a body is too large to hold and then hold it. It is also not merely wasteful: a
 * bucket that sends headers and then stalls makes `text()` block for the full
 * request timeout, inside a `mediaPool` slot, for bytes nobody wants. Cancelling
 * releases the socket without reading a byte. (Copilot.)
 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed, already errored, or no body at all — the connection is
    // going away regardless, and this is cleanup on a path that is already
    // returning a failure.
  }
}

/** Where a reader is sent. Public by construction — that is the point of the mode. */
export function publicUrl(cfg: S3CacheConfig, key: string): string {
  return `${cfg.publicBaseUrl}/${objectKey(cfg, key)}`;
}

/**
 * The public URL for a cached image, or null to use the proxy.
 *
 * ⚠⚠ THIS IS THE WHOLE POINT OF THE `s3` MODE, and it is the reason there is no
 * redirect anywhere in this feature. `toDescriptor` mints `src`/`thumb` per
 * request and clients treat both as opaque, so the cheapest place to send a reader
 * to the CDN is at MINT time: no 302, no second round trip through the cell, and
 * no chance of a client forwarding its `Authorization` header to a third-party
 * host, which is what a redirect would have invited.
 *
 * ⚠ Returning null is always SAFE, and that property is what makes this
 * comfortable. The caller falls back to the proxy path, which works regardless of
 * cache state — an empty bucket, a stale index, a mode change mid-flight all
 * degrade to exactly the behaviour that shipped before any of this existed. The
 * one shape that CANNOT self-correct is minting a URL for an object that is not
 * there: the client fetches the CDN directly, so its 404 never reaches us. That is
 * why the age bound is enforced here and not only on the read path.
 *
 * ⚠ `peekCached`, never `lookupCached`: this runs once per image per resolve, and
 * once per image per row once Part 2's `previewsForTexts` ships it into snapshot
 * building. The `last_access` touch is a WAL write on the shared connection.
 *
 * ⚠ Never throws — same promise the rest of the cache makes. It sits in the middle
 * of `toDescriptor`, which has no business failing because a cache lookup did.
 */
export function publicByteUrl(imageUrl: string): string | null {
  try {
    const cfg = cacheConfig();
    if (cfg.mode !== 's3') return null;

    const key = byteCacheKey(imageUrl);
    const entry = peekCached(key);
    if (!entry || entry.backend !== 's3' || expired(entry.createdAt)) return null;
    return publicUrl(cfg, key);
  } catch {
    return null;
  }
}

/**
 * ⚠ The prefix is already sanitised and slash-trimmed by `resolveCacheConfig`, and
 * `key` is a hex digest, so the result needs no percent-encoding — which is what
 * lets the signed URL and the public URL agree byte for byte and sidesteps the
 * classic SigV4 encoding mismatch.
 */
export function objectKey(cfg: S3CacheConfig, key: string): string {
  return cfg.prefix ? `${cfg.prefix}/${key}` : key;
}

/**
 * ⚠⚠ Distinguishes GONE from BROKEN, exactly as `local`'s read does, and for the
 * same reason: only a genuinely absent object may forget its index row. A 403, a
 * timeout or a DNS failure is a miss and nothing more — treating those as "the
 * object is gone" would delete the index while the bytes sit in the bucket,
 * unnameable and unbilled-for by anything that could clean them up.
 */
export type S3Read =
  | { kind: 'ok'; body: Buffer; contentType: string }
  | { kind: 'missing' }
  | { kind: 'error' };

/**
 * Read one object back through the bucket's API.
 *
 * ⚠ This is NOT the common path, and it is worth knowing why it exists at all.
 * Once an object is stored, the descriptor mints its public URL and clients fetch
 * it without touching the cell. A request arriving at the proxy for a key we have
 * therefore means a client is holding a descriptor minted BEFORE the store landed
 * — so this both serves them without a third-party round trip and, on a 404,
 * repairs the row that told us the object was there.
 *
 * ⚠ `fetch` rather than `node:http` deliberately, unlike the write path. The
 * memory hazard measured in #543 is undici buffering REQUEST bodies; a response
 * body is read once into a bounded buffer here, the same shape as `local`'s
 * `readFile`, and bounded by the same `mediaPool`.
 */
export async function readS3(cfg: S3CacheConfig, key: string, maxBytes: number): Promise<S3Read> {
  try {
    const signed = signObjectRequest({
      method: 'GET',
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      key: objectKey(cfg, key),
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    const res = await fetch(signed.url, {
      method: 'GET',
      headers: signed.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      await discard(res);
      return { kind: 'missing' };
    }
    if (!res.ok) {
      await discard(res);
      return { kind: 'error' };
    }
    // ⚠⚠ Bounded before reading, not after — and an ABSENT length is declined, not
    // waved through. `headers.get()` answers null when the header is missing and
    // `Number(null)` is 0, which is finite and under any cap, so a `Number.isFinite`
    // test alone passes exactly the responses it cannot bound: a chunked reply from
    // a caching proxy in front of the bucket, or a large object someone else wrote
    // to that key. `arrayBuffer()` would then pull the whole thing into the heap
    // inside a `mediaPool` slot, which is what this guard exists to stop.
    const raw = res.headers.get('content-length');
    const declared = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(declared) || declared > maxBytes) {
      // ⚠⚠ CANCELLED, not read. `res.text()` here would buffer the very body this
      // branch exists to refuse — the guard would announce the response is too big
      // to hold and then hold it. Worse, against a bucket that sends headers and
      // stalls it blocks for the full 30 s timeout inside a `mediaPool` slot.
      await discard(res);
      return { kind: 'error' };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) return { kind: 'error' };
    return {
      kind: 'ok',
      body,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Delete one object.
 *
 * ⚠ Reports whether it is actually GONE, the same contract as `removeLocal`, and
 * for the same reason: the caller drops the index row only for what it really
 * removed. S3 DeleteObject is idempotent by protocol — deleting an absent key
 * returns 204 — so there is no 404 carve-out to make here.
 */
export async function removeS3(cfg: S3CacheConfig, key: string): Promise<boolean> {
  try {
    const signed = signObjectRequest({
      method: 'DELETE',
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      key: objectKey(cfg, key),
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    const res = await fetch(signed.url, {
      method: 'DELETE',
      headers: signed.headers,
      signal: AbortSignal.timeout(30_000),
    });
    await discard(res);
    return res.ok;
  } catch {
    return false;
  }
}

/** A store in progress. Mirrors `LocalWriter`, except `commit` needs the content
 *  type: it goes ON the object rather than only into the index row. */
export interface S3Writer {
  write(chunk: Buffer): void;
  commit(contentType: string): Promise<boolean>;
  abort(): Promise<void>;
}

/**
 * Begin storing an object whose bytes are still arriving.
 *
 * ⚠⚠ STAGED TO A FILE, never collected in memory. SigV4 has to hash the payload
 * before it can sign, so the bytes are read twice — and the route hands them over
 * chunk by chunk as they stream from the origin. Buffering would cost the 8 MB
 * per-request image ceiling times `mediaPool`'s 24 slots, and worse: the route
 * deliberately does not await a store, so a buffer outlives the pool slot that
 * bounded it and nothing caps how many accumulate. The reference implementation
 * did exactly this, via `fetch` with `new Uint8Array(body)` — the shape measured
 * at FIVE TIMES the payload in live bytes (#543), and the reason
 * `uploadProviders/multipart.ts` exists at all.
 */
export async function openS3Write(cfg: S3CacheConfig, key: string): Promise<S3Writer | null> {
  // ⚠⚠ ITS OWN BOUND, because `mediaPool`'s does not reach this far. The route
  // calls `commit` without awaiting it — deliberately, so a slow bucket cannot
  // hold a reader's response open — and hands its pool slot back on the response's
  // `close` at the same moment. The hash pass and the PUT therefore run entirely
  // OUTSIDE the 24 slots, for up to `putSource`'s 60 s timeout, each one pinning a
  // staged file and an outbound socket. Without this, one authenticated session at
  // the route's own rate limit accumulates hundreds of staged files (gigabytes in
  // a directory nothing sweeps for `s3`) and hundreds of simultaneous sockets, in
  // the process running every tenant's IRC connections.
  //
  // ⚠ DECLINED at the ceiling, never queued. A queue would bound the sockets and
  // not the files, and would make an already-slow bucket slower still; declining
  // is free, because the reader has their bytes and all that is lost is the saving
  // on the next read.
  if (storesInFlight >= MAX_STORES_IN_FLIGHT) return null;

  const staged = await openTempFile(cfg.stagingDir, key);
  if (!staged) return null;

  storesInFlight++;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    storesInFlight--;
  };

  return {
    write(chunk: Buffer): void {
      staged.write(chunk);
    },
    async commit(contentType: string): Promise<boolean> {
      if (!(await staged.close())) {
        settle();
        return false;
      }
      try {
        const { size } = await fs.stat(staged.path);
        const source = fileSource(staged.path, size);
        // Two streamed passes over a warm temp file — one to hash, one to send —
        // rather than one pass through the heap. Same trade the uploader makes.
        const payloadHash = await hashOf(source);
        const signed = signObjectRequest({
          method: 'PUT',
          endpoint: cfg.endpoint,
          bucket: cfg.bucket,
          key: objectKey(cfg, key),
          payloadHash,
          contentType,
          cacheControl: OBJECT_CACHE_CONTROL,
          contentDisposition: OBJECT_CONTENT_DISPOSITION,
          region: cfg.region,
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
        });
        // ⚠ `putSource` is node:http with a 60 s default timeout, so a bucket that
        // accepts the connection and never replies cannot pin a staged file
        // forever. The reference used bare `fetch` with no signal at all: one
        // stalled PUT per miss, each holding its payload, in the process running
        // every tenant's IRC connections — an OOM reachable from a config typo.
        const resp = await putSource(signed.url, source, { headers: signed.headers });
        if (resp.status >= 200 && resp.status < 300) return true;
        warnOnce(`bucket refused a store: ${resp.status} ${resp.text.slice(0, 200)}`);
        return false;
      } catch (err) {
        warnOnce(`store failed: ${(err as Error)?.message ?? err}`);
        return false;
      } finally {
        // ⚠ ALWAYS, on every exit. The staging file is ours and nothing else knows
        // it exists — not the index, not eviction — so a leak here is bytes on the
        // volume that no later pass can find.
        await fs.unlink(staged.path).catch(() => {});
        settle();
      }
    },
    async abort(): Promise<void> {
      await staged.discard();
      settle();
    },
  };
}
