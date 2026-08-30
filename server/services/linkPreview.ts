// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver: URL in, preview descriptor out, cached in between.
//
// Lazily driven. Nothing here runs on message arrival — a client asks for a URL
// when it's about to render one and the user has a setting on, which is what
// makes both features genuinely free when they're off. It also means scrollback
// and live messages take the identical path, so there is no backfill story and
// no "preview arrives after the message" race to design around.
//
// ⚠⚠ Since the lurker-previews split (lurker-dev/LINK_PREVIEWS_ISOLATION.md),
// NOTHING in this process touches an origin or parses what one sent. The fetch
// walk, the scrape, the oEmbed calls, sharp, ffmpeg — all of it lives in the
// decoder, reached through `previewClient`, so the process holding every IRC
// session and the session secret never runs a media parser on a stranger's
// bytes. What stays here is everything that gives an answer identity and a
// lifetime: the cache, TTL policy, in-flight coalescing, URL re-stamping and
// descriptor minting — the parts that only mean something next to the database.
//
// The decoder's verdicts and what the cell does with each:
//
//   ok       → a record; TTL computed here (see recordFromMeta)
//   none     → `unavailable`, FAIL_TTL row — fetched fine, nothing worth a card
//   refused  → `unavailable`, FAIL_TTL row, one warn line (misconfigured link or probing)
//   dead     → `unavailable`, FAIL_TTL row
//   backoff  → `unavailable`, short TTL, NO row — the origin's mood, not the URL's nature
//   down     → `unavailable`, transient TTL, NO row — OUR seam's mood, same reasoning
//
// ⚠⚠ The last three never write a row. Caching a moment as a verdict is the
// permanently-blank-preview bug in every one of its historical costumes.

import { previewsEnabled } from '../utils/previews.js';
import { SlotPool } from '../utils/slotPool.js';
import {
  getCachedPreview,
  putPreview,
  urlHash,
  OK_TTL_MS,
  FAIL_TTL_MS,
  type PreviewRecord,
} from '../db/linkPreviews.js';
import { mintProxyToken, mintPosterToken } from './mediaProxyToken.js';
import { isEmbeddableOrigin } from './linkEmbed.js';
import { decoderResolve, type DecoderMeta, type DecoderPoster } from './previewClient.js';
// ⚠ `publicByteUrl` from `previewCache/publicUrl.js` for the historical cycle reason
// (see that file); `store`/`cacheEnabled`/`posterCacheKey` from the index is fine now
// that `kindForContentType` lives in previewShared.ts rather than here.
import { publicByteUrl } from './previewCache/publicUrl.js';
import { store, cacheEnabled, posterCacheKey, isPosterKey } from './previewCache/index.js';

/**
 * Longest URL we'll carry, checked here before anything is hashed, stored or echoed —
 * the decoder re-checks the normalised form (percent-encoding expands non-ASCII
 * threefold), but this one arrived in a request body and nothing upstream caps it.
 */
const MAX_URL_LENGTH = 2048;

/** Cap on URLs one resolve request may carry. Lives here rather than in the route so it can
 *  be tied to the concurrency limit below, which has to be at least this big. */
export const MAX_URLS_PER_REQUEST = 20;

/**
 * Decoder resolves in flight across the whole instance.
 *
 * ⚠ Must be >= MAX_URLS_PER_REQUEST, and overflow must QUEUE rather than fail. An earlier
 * version had a cap of 6 and answered overflow with `unavailable` immediately, which quietly
 * broke the common case rather than a rare one: `resolvePreview` runs synchronously up to its
 * first await, so `Promise.all` over a 20-URL batch started all 20 before any finished — calls
 * 7 through 20 saw a full pool and were refused without ever asking. On a link-heavy history
 * page 6 previews rendered and 14 links stayed bare, and because the client stores whatever
 * verdict it's given, they stayed bare for the rest of the session.
 *
 * ⚠ The DNS-starvation rationale that used to sit here — uncancellable `getaddrinfo` on the
 * libuv pool this process shares with IRC connection setup — MOVED with the fetches: origin
 * lookups happen in the decoder now, where the worst case is previews getting slower. What
 * this pool still bounds is plumbing toward the decoder (sockets, queued work, and the memory
 * a batch of answers holds), and the give-up behaviour below is unchanged.
 */
const MAX_CONCURRENT = MAX_URLS_PER_REQUEST;
/**
 * Callers parked waiting for a slot, bounded so a flood can't grow this without limit.
 * Cross-request contention is what queues here; a single batch never has to.
 */
const MAX_QUEUED = 200;
/** How long a caller will wait for a slot before giving up, so an HTTP request can't hang on
 *  a backlog of slow resolves. Recoverable: an `unavailable` from here is written to neither
 *  cache — no row here, and a TRANSIENT_TTL_MS `expiresAt` so the client re-asks in seconds. */
const MAX_QUEUE_WAIT_MS = 10_000;

const pool = new SlotPool({
  size: MAX_CONCURRENT,
  maxQueued: MAX_QUEUED,
  waitMs: MAX_QUEUE_WAIT_MS,
});

/**
 * Coalesce concurrent resolutions of the same URL.
 *
 * Fifty people in a channel scrolling past the same link is fifty requests
 * arriving within a second of each other and one cache entry that doesn't exist
 * yet. Without this they'd be fifty decoder calls — and at the far end fifty
 * sockets to the same host, which is precisely the behaviour that gets an IP
 * rate-limited.
 */
const inFlight = new Map<string, Promise<PreviewRecord>>();

function unavailable(url: string, ttlMs: number = FAIL_TTL_MS): PreviewRecord {
  return {
    url,
    status: 'unavailable',
    kind: 'page',
    title: null,
    description: null,
    siteName: null,
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: null,
    posterKey: null,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/**
 * How long a client should sit on an `unavailable` that says nothing about the URL.
 *
 * ⚠ Keeping the record out of the server's cache is only half of "don't cache a transient
 * failure". `expiresAt` goes out on the wire and is the ONLY thing a client has for deciding
 * when to ask again — so a saturation answer stamped with the one-hour failure TTL got cached
 * for an hour by the client regardless, which is the permanently-blank-preview outcome the
 * server-side decision was made to avoid.
 *
 * Short rather than zero so a saturated instance doesn't get re-asked in a tight loop, and
 * JITTERED so that every loser of one saturation event doesn't come back as a single wave.
 *
 * ⚠ What this does NOT do, stated because the paragraph above reads like it does: no shipped
 * client honours `expiresAt` yet — the iOS model omits the field and gates re-asks on a set, so
 * a transient answer stays blank there for the session. That is a client bug and it belongs to
 * PRs 5 and 6; sending the right number is this end's half of it, and sending the wrong one
 * would make the client half unfixable.
 */
const TRANSIENT_TTL_MS = 15_000;

/** ±25%, so simultaneous losers don't retry in lockstep. */
function transientTtl(): number {
  return Math.round(TRANSIENT_TTL_MS * (0.75 + Math.random() * 0.5));
}

/**
 * The cache, wrapped so a database error degrades one URL instead of a whole batch.
 *
 * ⚠ `resolvePreview` promises never to throw and the route builds a `Promise.all` on that
 * promise. Both of these are synchronous better-sqlite3 calls on the single shared connection,
 * and this repo has a documented history of SQLITE_BUSY under Litestream — so an unguarded
 * throw here turns a transient lock into a 500 for all twenty URLs in the request. Logged
 * rather than swallowed: a cache that has stopped working is worth knowing about, but it is
 * degradation, not failure. Missing the read costs a refetch; missing the write costs another.
 */
function readCache(url: string): PreviewRecord | null {
  try {
    return getCachedPreview(url);
  } catch (err) {
    console.warn(`[lurker] link preview cache read failed: ${String(err)}`);
    return null;
  }
}

function writeCache(record: PreviewRecord): void {
  try {
    putPreview(record);
  } catch (err) {
    console.warn(`[lurker] link preview cache write failed: ${String(err)}`);
  }
}

/**
 * A decoder `ok` turned into a record: identity stamped, TTL computed, poster stored.
 *
 * ⚠ The TTL rule is subtler than it looks and is owed to a real bug: a record whose only
 * content is an `embedUrl` (provider oEmbed failed, scrape found nothing — YouTube's og:
 * tags sit past the decoder's scrape cap) is a DEGRADED answer, a play button and a
 * hostname. Giving it the seven-day success TTL cached one rate-limited minute for a week;
 * the failure TTL retries within the hour, which is what the situation actually calls for.
 * `title || imageUrl` is exactly the line between a full card and that case.
 */
async function recordFromMeta(
  raw: string,
  meta: DecoderMeta,
  poster: DecoderPoster | null,
): Promise<PreviewRecord> {
  let posterKey: string | null = null;
  let imageWidth = meta.imageWidth;
  let imageHeight = meta.imageHeight;
  if (poster && (meta.kind === 'video' || meta.kind === 'audio') && cacheEnabled()) {
    // ⚠⚠ A poster is the first preview image with NO ORIGIN URL — these bytes exist nowhere
    // but here, so there is no proxy-path fallback to re-fetch them through. That is why the
    // key lands in the ROW only when the store succeeded: a posterKey pointing at nothing
    // would mint a thumb that 404s for everyone, for a week. Cache off (or full, or the
    // signature check refusing the bytes) → posterless card, which is a complete state.
    //
    // ⚠ `store` runs the byte cache's own image-signature check before keeping anything —
    // the decoder is the box we expect to be compromised first, and its "JPEG" is a claim
    // until those magic bytes say so.
    const key = posterCacheKey(raw);
    if (await store(key, poster.jpeg, 'image/jpeg')) {
      posterKey = key;
      // For video/audio rows these columns describe the POSTER (they were always null for
      // these kinds before posters existed) — it is the picture the client reserves a box
      // for, which is the whole reason the fields exist.
      imageWidth = poster.width;
      imageHeight = poster.height;
    }
  }
  return {
    url: raw,
    status: 'ok',
    kind: meta.kind,
    title: meta.title,
    description: meta.description,
    siteName: meta.siteName,
    author: meta.author,
    imageUrl: meta.imageUrl,
    imageWidth,
    imageHeight,
    embedUrl: meta.embedUrl,
    mime: meta.mime,
    posterKey,
    expiresAt: new Date(
      Date.now() + (meta.title || meta.imageUrl ? OK_TTL_MS : FAIL_TTL_MS),
    ).toISOString(),
  };
}

/**
 * Resolve one URL to a cached-or-fresh preview record.
 *
 * Never throws. Every failure path — malformed URL, blocked address, timeout,
 * 403, unusable content type, a decoder that is down — becomes an `unavailable`
 * record, which is a real answer rather than an error to handle. That's what
 * keeps a dead link in old scrollback from reopening a socket every time someone
 * scrolls past it.
 */
export async function resolvePreview(raw: string): Promise<PreviewRecord> {
  // The flag first, before even a cache read: "off" means the feature isn't participating, not
  // that it serves stale answers it happens to still have. The routes aren't mounted either —
  // this is the inner half of the same decision.
  if (!previewsEnabled()) return unavailable(raw, transientTtl());
  // Refused before it can be hashed, stored, or echoed. A stable verdict, so it keeps the
  // ordinary failure TTL — a URL this long will still be this long in an hour.
  if (raw.length > MAX_URL_LENGTH) return unavailable(raw);

  // ⚠ Guarded, because better-sqlite3 is synchronous on the one shared connection and a
  // single SQLITE_BUSY (documented here under Litestream) would otherwise reject the whole
  // `Promise.all` and 500 an entire 20-URL batch.
  const cached = readCache(raw);
  // ⚠ Re-stamped with the URL as ASKED, not as stored. The row is keyed with the fragment
  // stripped so `#intro` and `#appendix` of one document share a fetch — which means the `url`
  // column holds whichever of them arrived first. Returning that verbatim is the client-side
  // miss that echoing a post-redirect URL caused, reached through the cache instead.
  if (cached) return { ...cached, url: raw };

  // ⚠ Keyed by the STORAGE identity, not by the request string, and re-stamped on the way out
  // for the same reason the cache read above is. Keyed by `raw`, two anchors of one document
  // arriving in the same batch — which is exactly how anchors arrive — coalesced with nothing
  // and cost two resolves of the same page.
  const key = urlHash(raw);
  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), url: raw };

  const task = (async (): Promise<PreviewRecord> => {
    // ⚠ `acquired` and the try must wrap EVERYTHING, including the give-up path. An earlier
    // version returned before entering the try, so `finally` never ran and the resolved
    // `unavailable` promise stayed pinned in `inFlight` for the life of the process — every
    // later request for that URL replayed it and never consulted the DB cache again.
    let acquired = false;
    try {
      acquired = await pool.acquire();
      if (!acquired) {
        // Deliberately NOT cached, at either end: this says nothing about the URL, only that
        // the instance was saturated when we asked.
        return unavailable(raw, transientTtl());
      }
      // Posters are only worth asking for when the byte cache can keep them — the decoder
      // makes them during resolve, and bytes nothing can store are bytes fetched for nothing.
      // `decoderResolve` never throws and owns its own deadline (the decoder bounds one
      // resolution at 30 s), so the slot this task holds is bounded without a race here.
      const out = await decoderResolve(raw, cacheEnabled());
      switch (out.status) {
        case 'ok': {
          const record = await recordFromMeta(raw, out.meta, out.poster);
          writeCache(record);
          return record;
        }
        case 'refused':
          // Worth a line — it's either a misconfigured link or somebody probing, and the
          // decoder sent the guard's own message along for exactly this log.
          console.warn(`[lurker] link preview refused: ${out.reason}`);
          break;
        case 'none':
        case 'dead':
          // Ordinary internet weather, cached as the stable verdict it is.
          break;
        case 'backoff': {
          // ⚠ The origin asked for a pause and said how long. NO row — "not now" cached as
          // "not ever" is the transient-split defect — and the client's expiresAt honours
          // the origin's own figure, capped so one absurd Retry-After can't park a URL for
          // a session.
          return unavailable(raw, Math.min(out.retryAfterS, 300) * 1000);
        }
        case 'down':
          // The decoder is unreachable or mid-deploy: a fact about our seam, not the URL.
          return unavailable(raw, transientTtl());
      }
      const record = unavailable(raw);
      writeCache(record);
      return record;
    } finally {
      // Only release what we actually took; always clear the in-flight entry.
      if (acquired) pool.release();
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return { ...(await task), url: raw };
}

/** The wire shape handed to clients. Byte URLs are minted here, so a client
 *  never learns to construct one — see mediaProxyToken. */
export interface PreviewDescriptor {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewRecord['kind'];
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  src?: string;
  thumb?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  embedUrl?: string;
  mime?: string;
  expiresAt: string;
}

export function toDescriptor(record: PreviewRecord): PreviewDescriptor {
  const d: PreviewDescriptor = {
    url: record.url,
    status: record.status,
    kind: record.kind,
    expiresAt: record.expiresAt,
  };
  if (record.status !== 'ok') return d;

  if (record.title) d.title = record.title;
  if (record.description) d.description = record.description;
  if (record.siteName) d.siteName = record.siteName;
  if (record.author) d.author = record.author;
  if (record.mime) d.mime = record.mime;
  // ⚠ Re-checked on the way out, against the shared allowlist rather than a `startsWith`.
  // `embedUrl` is the one field a client puts in an <iframe>, and this value came back out of
  // a cache row — so what's asserted here isn't "did the decoder behave", it's "whatever is
  // in the row, we only ever hand clients an origin we're willing to frame". There is still no
  // CSP anywhere in this repo, so this check is the frame-src. It is also half of why the
  // provider table deliberately exists in BOTH repos (the decoder classifies with its copy):
  // drift fails closed, right here, as a page card.
  if (record.embedUrl && isEmbeddableOrigin(record.embedUrl)) {
    d.embedUrl = record.embedUrl;
  } else if (record.kind === 'video-embed') {
    // ⚠ Withholding the URL but keeping `kind: 'video-embed'` describes something that cannot
    // exist — a client renders a play button wired to nothing. The honest downgrade is a page
    // card, which is what it now is.
    d.kind = 'page';
  }

  // ⚠⚠ VIDEO AND AUDIO ARE GIVEN NO BYTE URL AT ALL, AND THAT IS THE FEATURE.
  //
  // The proxy exists to stop a card the reader never asked for from telling a stranger's
  // server who is reading — unintended view stats. It was never meant to be an anonymizing
  // relay for content someone deliberately plays. Withholding `src` is what makes the card
  // click-to-activate, and it is what stopped one 44 MB clip being relayed once PER VIEWER,
  // PER VIEW, forever — the relay that exhausted the control plane's socket memory on
  // 2026-08-10. The user-facing half of this policy is in docs/SELF_HOSTING.md.
  const relaysBytes = record.kind !== 'video' && record.kind !== 'audio';
  if (record.imageUrl && relaysBytes) {
    // ⚠⚠ A CACHED object is served from its own public URL, and only the mint site
    // knows that. `src`/`thumb` are opaque to every client — nothing constructs one,
    // nothing parses one — so substituting a CDN URL for a proxy path here is
    // invisible on the wire and costs no protocol change, no version bump and no
    // client release.
    //
    // ⚠ The fallback is the whole design. `publicByteUrl` answers null for anything
    // it is not certain of — cache off, `local` mode, no row, a row past its age
    // bound — and null means the proxy path, which works in every one of those
    // states. The FIRST reader of an image always takes it, because nothing is
    // cached until that request streams through and populates the cache.
    const proxied =
      publicByteUrl(record.imageUrl) ??
      `/api/link-preview/media/${mintProxyToken(record.imageUrl)}`;
    // For direct media the bytes ARE the content (`src`); for a page they're
    // decoration on a card (`thumb`). Same proxy, different slot, so a client
    // never has to re-derive which one it's looking at from `kind`.
    if (record.kind === 'image') {
      d.src = proxied;
    } else {
      d.thumb = proxied;
    }
    // ⚠ Inside the block, because these describe the image that is being SENT. Emitted
    // unconditionally they shipped a thumbWidth/thumbHeight for a `thumb` the record didn't
    // have, so a client reserved a box for a picture that was never coming — the reflow these
    // fields exist to prevent, caused by the fields themselves.
    if (record.imageWidth) d.thumbWidth = record.imageWidth;
    if (record.imageHeight) d.thumbHeight = record.imageHeight;
  } else if (!relaysBytes && record.posterKey && isPosterKey(record.posterKey)) {
    // The poster: a first frame this instance decoded and stored itself, served from a
    // dedicated route because — unlike every other preview image — it has NO origin URL for
    // the proxy path to fall back to. The route answers from the byte cache and 404s on a
    // miss, and a missing poster is a supported state: the card renders without it.
    //
    // ⚠ Still `thumb`, same slot page cards use: decoration on a card, never the content —
    // the media policy's line between a poster and the clip it advertises.
    // ⚠ A SIGNED token, not the bare key. The key is an unsalted hash a client can compute
    // for any URL; the token is the capability that keeps the poster route from serving the
    // shared byte cache to anyone who asks — see mintPosterToken.
    d.thumb = `/api/link-preview/poster/${mintPosterToken(record.posterKey)}`;
    // For these rows the stored dimensions ARE the poster's — see PreviewRecord.posterKey.
    if (record.imageWidth) d.thumbWidth = record.imageWidth;
    if (record.imageHeight) d.thumbHeight = record.imageHeight;
  }
  return d;
}
