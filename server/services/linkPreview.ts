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
// The Lounge does the opposite (fetch eagerly in the PRIVMSG handler, decorate
// the stored message), which is right for a server-global config knob and wrong
// for a per-user, default-off setting.

import sharp from 'sharp';
import { dimensionsFromHeader } from '../utils/imageHeader.js';
import {
  bufferStream,
  fetchBuffered,
  normalizeUrl,
  safeRequest,
  MAX_SCRAPE_BYTES,
  UnsafeUrlError,
  type RawResponse,
} from './linkFetch.js';
import { scrapeMeta, readOEmbed, decodeBody, type OEmbedMeta } from './linkMeta.js';
import { videoEmbedFor, oembedEndpointFor, isEmbeddableOrigin } from './linkEmbed.js';
import { previewsEnabled } from '../utils/previews.js';
import { SlotPool } from '../utils/slotPool.js';
import { withDeadline, DeadlineExceeded } from '../utils/withDeadline.js';
import {
  getCachedPreview,
  putPreview,
  urlHash,
  OK_TTL_MS,
  FAIL_TTL_MS,
  type PreviewRecord,
  type PreviewKind,
} from '../db/linkPreviews.js';
import { mintProxyToken } from './mediaProxyToken.js';
// ⚠ From `previewCache/s3.js`, not `previewCache/index.js`. The index imports this
// module for `kindForContentType`, so reaching back through it would close a cycle.
import { publicByteUrl } from './previewCache/s3.js';

/** Clamps, applied server-side so no client has to think about them and no
 *  client can be surprised by a 40 KB og:description. */
const MAX_TITLE = 140;
const MAX_DESCRIPTION = 300;
/**
 * Longest URL we'll carry.
 *
 * Applies to the URL asked about AND to any og:image / oEmbed thumbnail found on the page,
 * because both end up in a row, in a response, and — for the image — inside a minted proxy
 * token, which is base64 of the URL and therefore a third longer again. Nothing upstream caps
 * these: `normalizeUrl` is happy with a megabyte of query string, and `readOEmbed` reads a
 * `thumbnail_url` of any length straight out of a stranger's JSON. 2 KB is the de-facto ceiling
 * every browser and CDN already enforces, so anything past it wasn't going to load anyway.
 */
const MAX_URL_LENGTH = 2048;

/** Cap on URLs one resolve request may carry. Lives here rather than in the route so it can
 *  be tied to the concurrency limit below, which has to be at least this big. */
export const MAX_URLS_PER_REQUEST = 20;

/**
 * Outbound fetches in flight across the whole instance.
 *
 * A cap rather than a queue-per-user: the resource being protected is the instance's egress and
 * its standing with the hosts it talks to, and neither cares which account caused the traffic.
 *
 * ⚠ Must be >= MAX_URLS_PER_REQUEST, and overflow must QUEUE rather than fail. An earlier
 * version had a cap of 6 and answered overflow with `unavailable` immediately, which quietly
 * broke the common case rather than a rare one: `resolvePreview` runs synchronously up to its
 * first await, so `Promise.all` over a 20-URL batch started all 20 before any finished — calls
 * 7 through 20 saw a full pool and were refused without ever dialling. On a link-heavy history
 * page 6 previews rendered and 14 links stayed bare, and because the client stores whatever
 * verdict it's given, they stayed bare for the rest of the session.
 *
 * ⚠ This is also what bounds how many DNS lookups RESOLVING has outstanding, and that matters
 * more than it reads. (The byte proxy is the other half and needs its own — see `mediaPool` in
 * routes/linkPreview.ts, which is the higher-volume one: a link resolves once, but every image
 * on screen is a byte request.) `getaddrinfo` runs on libuv's thread pool, which caps it at
 * `(nthreads + 1) / 2` slots, and it CANNOT be cancelled — `req.destroy()` returns at once
 * while the lookup keeps its slot for the full OS timeout. Measured while building this: eight
 * concurrent blackholed lookups delayed an unrelated `dns.lookup` by ~20 s, and on this server
 * the other DNS consumer is IRC connection setup.
 *
 * The honest limits of the bound, since a comment claiming a guarantee is a claim to test:
 * it bounds fetches in flight, not lookups outstanding. A hop that gives up at
 * HOP_DEADLINE_MS frees its slot to a new fetch while its own lookup is still pending, so a
 * sustained stream of unresolvable hostnames can leave more than MAX_CONCURRENT lookups queued.
 * Fixing that needs a cancellable resolver (`dns.Resolver` over UDP rather than getaddrinfo),
 * which is a change to the fetcher, not to its caller. Bounding it here is what's available,
 * and it is strictly better than not bounding it.
 *
 * ⚠ "Fetches in flight" is only true because RESOLVE_DEADLINE_MS **aborts** rather than merely
 * stops waiting. Racing a promise abandons the work, and an abandoned fetch keeps its socket
 * for its own hop budget — so releasing the slot at that moment let the pool undercount its own
 * work, and a run of slow origins pushed the real number of live fetches past MAX_CONCURRENT
 * without bound. The signal threaded through `doResolve` is what makes the release honest, and
 * it is load-bearing for this paragraph rather than a tidiness.
 *
 * ⚠ Do NOT try to bound this with `maxSockets` on linkFetch's agents instead. node marks a
 * request `shouldKeepAlive = false` only when `!agent.keepAlive && !isFinite(agent.maxSockets)`,
 * and the agent hands a released socket to a queued same-host request before it ever consults
 * `keepAlive` — so capping the agents silently restores socket reuse, and a reused socket skips
 * DNS, which skips the pinned lookup that is the SSRF guard.
 */
const MAX_CONCURRENT = MAX_URLS_PER_REQUEST;
/**
 * Callers parked waiting for a slot, bounded so a flood can't grow this without limit.
 * Cross-request contention is what queues here; a single batch never has to.
 */
const MAX_QUEUED = 200;
/** How long a caller will wait for a slot before giving up, so an HTTP request can't hang on
 *  a backlog of slow origins. Recoverable: an `unavailable` from here is written to neither
 *  cache — no row here, and a TRANSIENT_TTL_MS `expiresAt` so the client re-asks in seconds. */
const MAX_QUEUE_WAIT_MS = 10_000;

/**
 * Ceiling on one URL's whole resolution, once it holds a slot.
 *
 * ⚠ Without this the per-hop bounds multiply out to something absurd, and it is the SLOT that
 * makes it everyone's problem. One URL can chain three separate fetch walks — the provider
 * oEmbed call, the page fetch it falls through to, and the oEmbed endpoint discovered in that
 * page — each of MAX_REDIRECTS + 1 hops at HOP_DEADLINE_MS, so roughly four minutes of holding
 * one of MAX_CONCURRENT slots while every other caller's `acquire` times out. Nothing else cuts
 * it: there is no `server.requestTimeout` configured anywhere in this repo, so the queue wait's
 * promise that "an HTTP request can't hang on a backlog of slow origins" was off by ~25x.
 *
 * A URL that hits this is transient, not a verdict — the origin was slow, which is a fact about
 * a moment. So it gets the short client TTL and no row, like saturation.
 */
const RESOLVE_DEADLINE_MS = 30_000;

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
 * yet. Without this they'd be fifty sockets to the same host, which is both
 * wasteful and precisely the behaviour that gets an IP rate-limited. The Lounge
 * keeps the same structure for the same reason.
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
 * server-side decision was made to avoid. The comment saying "the client re-asks on the next
 * priming pass" was true only for a client that ignores the field, which is not something this
 * end can enforce or should assume.
 *
 * Short rather than zero so a saturated instance doesn't get re-asked in a tight loop, and
 * JITTERED so that every loser of one saturation event doesn't come back as a single wave
 * against a pool still holding the slow origins that caused it.
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
 * Trim and shorten a scraped string for display.
 *
 * ⚠ Cut on CODE POINTS, not on `String.prototype.slice`, which counts UTF-16 code units and
 * will happily halve a surrogate pair. A title of emoji clamped at 140 ended in a lone high
 * surrogate — which does not survive the SQLite round trip, so the requester who resolved the
 * URL and everyone served from the cache afterwards got measurably different strings for the
 * same page, and a strict JSON decoder (iOS) turned it into U+FFFD. These are display clamps,
 * not byte budgets; there is no reason for them to be able to split a character.
 */
function clamp(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ⚠ The cheap check FIRST. A code point is never fewer than one UTF-16 code unit, so
  // `length <= max` is an exact proof that no clamp is needed — and it is O(1) where
  // `Array.from` is O(n) over a string an attacker chooses the size of. `scrapeMeta` does not
  // pre-bound attribute values, so one og:description can be the whole 512 KB scrape budget:
  // measured at 986 us per call versus 2.9 us with this line, and `clamp` runs four times per
  // record across a 20-URL batch. That is ~80 ms of unbroken synchronous work on the thread
  // holding every IRC socket, in a repo that runs an event-loop monitor because exactly this
  // class of stall trips ping timeouts.
  if (trimmed.length <= max) return trimmed;
  const points = Array.from(trimmed);
  if (points.length <= max) return trimmed;
  return `${points.slice(0, max - 1).join('')}…`;
}

/**
 * What a Content-Type means for rendering.
 *
 * SVG is deliberately absent from the image branch. It is a document format that
 * executes script, not a picture — the uploader already refuses it (#553-era
 * media scrubbing), and letting one in here would reintroduce the same hole
 * through a different door.
 */
/** ⚠ Exported so the byte cache can ask the SAME allowlist rather than keeping a
 *  second copy. `image/svg+xml` is refused here and nowhere else, and a duplicated
 *  rule is how it nearly got served under our own origin once already. */
export function kindForContentType(contentType: string): PreviewKind | null {
  if (contentType === 'image/svg+xml') return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'page';
  return null;
}

/** Fetch a discovered oEmbed endpoint. Best-effort: a failure just means we fall
 *  back to whatever the Open Graph tags gave us. */
async function fetchOEmbed(
  raw: string,
  base: URL,
  signal: AbortSignal,
): Promise<ReturnType<typeof readOEmbed>> {
  // ⚠ The RESOLVE is inside the try, not just the normalize — the same shape `safeRequest`
  // needed for a redirect `Location`. `raw` is an href scraped out of a stranger's markup, and
  // `new URL('http://[', base)` throws ERR_INVALID_URL while BUILDING normalizeUrl's argument,
  // so normalizeUrl's own guard never sees it. Escaping as a raw TypeError doesn't get past
  // `resolvePreview`'s catch, but it does abandon the whole page — a broken oEmbed href would
  // cost a site its preview entirely, when oEmbed is the fallback path and skipping it should
  // leave the Open Graph tags we already have.
  let url: URL | null = null;
  try {
    url = normalizeUrl(new URL(raw, base).toString());
  } catch {
    return null;
  }
  if (!url) return null;
  try {
    const res = await fetchBuffered(url, {
      accept: 'application/json',
      maxBytes: 64 * 1024,
      signal,
    });
    if (res.status !== 200) return null;
    return readOEmbed(JSON.parse(res.body.toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Assemble a page record from whatever combination of oEmbed and scraped tags we got.
 *
 * ⚠ Exported for tests. The give-up rule below depends on `videoEmbedFor`, which only matches
 * real provider hosts — so the branch cannot be reached through a loopback origin, and a test
 * that goes through `toDescriptor` instead exercises none of this. It stayed green with the
 * rule reverted, which is how this export came to exist.
 */
export function pageRecord(
  url: URL,
  oembed: OEmbedMeta | null,
  meta: ReturnType<typeof scrapeMeta>,
): PreviewRecord {
  const embed = videoEmbedFor(url);
  const kind: PreviewKind = embed ? 'video-embed' : 'page';

  /**
   * Absolutise and vet one candidate image URL.
   *
   * og:image is routinely relative, and a relative URL resolves against the page we ACTUALLY
   * landed on, not the one we asked for — redirects move the base.
   *
   * ⚠ NOT decoded here. `scrapeMeta` and `readOEmbed` each decode entities at their own
   * boundary now, and decoding is deliberately once-only — a second pass turns a literal
   * `&amp;lt;` in a filename back into `<`, and `linkMeta.test.ts` asserts the single pass.
   */
  const absolutise = (candidate: string | undefined): string | null => {
    if (!candidate) return null;
    let abs: URL | null = null;
    try {
      abs = normalizeUrl(new URL(candidate, url).toString());
    } catch {
      // `new URL` throws on input `normalizeUrl` would merely refuse — and this input came
      // from a stranger's markup, so it reaches us as anything at all.
      return null;
    }
    if (!abs) return null;
    const str = abs.toString();
    return str.length <= MAX_URL_LENGTH ? str : null;
  };

  // ⚠ Each candidate is tried in turn, rather than picking one with `||` and then vetting it.
  // Choosing first meant a page with a perfectly good og:image lost it whenever the oEmbed
  // reply carried a thumbnail_url we refuse — a data: URI, a private-address host, something
  // over-length — because by then `meta.imageUrl` had already been discarded. If the page also
  // had no title that turned into a cached `unavailable`: no card at all, for an hour, because
  // the OPTIONAL source was bad.
  const oembedImage = absolutise(oembed?.thumbnailUrl);
  const imageUrl = oembedImage ?? absolutise(meta.imageUrl);

  const title = clamp(oembed?.title || meta.title, MAX_TITLE);
  const description = clamp(meta.description, MAX_DESCRIPTION);

  // A card with no title and no image is a grey rectangle that says nothing.
  // Better to render the plain link the user typed.
  //
  // ⚠ ...but an embed is a card in its own right, and title/image are PAGE concepts. Without
  // the `!embed` clause a YouTube link whose provider oEmbed call failed — rate-limited, or the
  // endpoint retired, neither of which "should mean no preview at all" — fell through to the
  // scrape, found nothing because YouTube's og: tags sit past the 512 KB cap, and threw away
  // the youtube-nocookie embed URL it was already holding. Then cached that for an hour.
  if (!title && !imageUrl && !embed) return unavailable(url.toString());

  return {
    url: url.toString(),
    status: 'ok',
    kind,
    title,
    description,
    siteName: clamp(oembed?.providerName || meta.siteName || url.hostname, MAX_TITLE),
    author: clamp(oembed?.authorName, MAX_TITLE),
    imageUrl,
    // ⚠ Only when the oEmbed thumbnail is the image we actually took. `thumbnail_width` and
    // `thumbnail_height` describe `thumbnail_url` and nothing else, so pairing them with an
    // og:image that won instead reserves a box of the wrong shape — a 4:3 hole for a 16:9
    // picture — which is precisely the reflow these fields exist to prevent.
    imageWidth: oembedImage ? (oembed?.thumbnailWidth ?? null) : null,
    imageHeight: oembedImage ? (oembed?.thumbnailHeight ?? null) : null,
    embedUrl: embed?.embedUrl ?? null,
    mime: null,
    // ⚠ A record kept ONLY by the `!embed` clause has no title, no description and no
    // thumbnail — its whole visible content is the hostname. That is worth rendering (the play
    // affordance is real) but it is a DEGRADED answer: the provider call that would have filled
    // those in is the thing that just failed. Giving it the seven-day success TTL cached one
    // rate-limited minute for a week; the failure TTL retries within the hour, which is what
    // the situation actually calls for.
    expiresAt: new Date(Date.now() + (title || imageUrl ? OK_TTL_MS : FAIL_TTL_MS)).toISOString(),
  };
}

/** Resolve an HTML page into a card by scraping it. */
async function resolveScrapedPage(
  url: URL,
  body: Buffer,
  charset: string | null,
  signal: AbortSignal,
): Promise<PreviewRecord> {
  // ⚠ The declared CHARSET, not the Content-Type header. `decodeBody` used to re-parse
  // `charset=…` out of what it was handed, but what reached it was `RawResponse.contentType`,
  // already stripped to a bare `text/html` — a branch that could never match, so
  // `charset=windows-1251` with no in-document `<meta charset>` fell through to UTF-8 and
  // rendered as replacement characters. `BufferedResponse` carries the parsed charset as its
  // own field for exactly this call.
  const html = decodeBody(body, charset);
  const meta = scrapeMeta(html);

  // Discovered oEmbed still wins over the scraped tags where a page advertises one, matching
  // Slack: it's a structured, versioned answer from the site itself rather than a bag of
  // strings. This is the discovery path, for sites not in the provider table.
  const oembed = meta.oembedUrl ? await fetchOEmbed(meta.oembedUrl, url, signal) : null;
  return pageRecord(url, oembed, meta);
}

/**
 * Pixel dimensions of an image, from as few bytes as we can get away with.
 *
 * Purely so clients can reserve the right amount of space *before* the bytes arrive. Without
 * it a message list grows twice — once when the metadata lands and again when the image
 * decodes — and in a bottom-anchored chat log the second one yanks the reader off the live
 * tail. With an aspect ratio in hand the box is allocated at metadata time and the image
 * simply appears inside it.
 *
 * A header-sized read is enough for every format that matters: the dimensions live in the
 * first few hundred bytes of a JPEG/PNG/GIF/WebP. Failure is fine (an exotic format, a header
 * sharp can't make sense of) — the client falls back to a reserved box, which costs a little
 * space rather than a layout jump.
 *
 * ⚠⚠ SHARP ALONE IS NOT ENOUGH, and the reason is counter-intuitive: it is not that the header
 * is truncated — every format here puts its dimensions in the first few dozen bytes — it is that
 * some containers declare a TOTAL LENGTH and their loaders refuse a file shorter than it claims,
 * before decoding anything. Measured at this exact cap: png, jpeg and avif read fine; webp, gif
 * and tiff all throw. No sharp option relaxes it (`failOn: 'none'` and `failOn: 'truncated'` both
 * still throw), because the rejection is above the decoder.
 *
 * QA saw this as "solo .webp images get a grey background but .png ones don't" — a size-specific
 * bug wearing a format-specific costume, since a WebP under 64 KB was measured correctly. The
 * fallback reads the two fields directly for the two formats that are ordinary to paste into IRC.
 */
async function imageDimensions(
  res: RawResponse,
): Promise<{ width: number; height: number } | null> {
  try {
    const head = await bufferStream(res, { maxBytes: 64 * 1024 });
    return await dimensionsFromHead(head.body);
  } catch {
    // The read itself failed. No dimensions means no reservation, not no preview.
  }
  return null;
}

/**
 * The measuring half, split out from the stream read so it can be TESTED.
 *
 * ⚠ Exported for the test alone, and that is worth one line of module surface: the resolver's
 * only route to real image bytes is a network fetch, and the SSRF guard blocks loopback by
 * design — so nothing that goes through `resolvePreview` can hand this function a real photo.
 * Un-split, the EXIF rule below was a claim backed by a console probe and by nothing that runs.
 */
export async function dimensionsFromHead(
  body: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(body).metadata();
    // ⚠⚠ `autoOrient`, NOT `width`/`height`. sharp reports the dimensions as STORED; a browser
    // decodes with `image-orientation: from-image` and applies the EXIF rotation, so for the
    // most ordinary photo on the platform — a phone JPEG with orientation 6 — the two disagree
    // by a transpose. Measured on the sharp in this tree: stored 400x300, `autoOrient`
    // {300,400}, and `.rotate()` (what the browser effectively does) 300x400.
    //
    // These numbers are a LAYOUT PROMISE, not a statistic: the client reserves the box from
    // this ratio before any bytes arrive (MessageAttachment's `reserveStyle`), so a transposed
    // pair means a portrait photo sits letterboxed in a landscape box — and on a column narrow
    // enough for `max-width` to bite, the wrong ratio drags the reserved height down with it.
    // `imagePipeline.ts` already calls `.rotate()` for the same reason; this is that rule on
    // the measuring path.
    const dims = meta.autoOrient ?? meta;
    if (dims.width && dims.height) return { width: dims.width, height: dims.height };
  } catch {
    // Fall through: sharp refusing a truncated container is the case below, not a dead end.
  }
  // ⚠ Second, never first. sharp handles more formats and is the better answer wherever it
  // works; this must not shadow it with a narrower implementation that could disagree.
  // ⚠ This fallback reads stored dimensions and knows nothing of EXIF, so it can still return a
  // transposed pair. It is reached only for a container sharp refuses at 64 KB — webp, gif and
  // tiff — and the orientation tag in the wild is a JPEG phenomenon, which sharp measures.
  return dimensionsFromHeader(body);
}

async function doResolve(raw: string, signal: AbortSignal): Promise<PreviewRecord> {
  const url = normalizeUrl(raw);
  if (!url) return unavailable(raw);
  // ⚠ Re-checked on the NORMALISED form. The gate in `resolvePreview` measures the request
  // string, but WHATWG percent-encoding expands every non-ASCII byte threefold, so a 2,014-
  // character URL of Cyrillic passes that gate and comes out of `normalizeUrl` at 12,014 — and
  // on the direct-media branch below that string is stored verbatim and minted into a proxy
  // path a third longer again, past node's own 16 KB header ceiling on the request that would
  // fetch it. Measured, not theorised.
  if (url.toString().length > MAX_URL_LENGTH) return unavailable(raw);

  // Known providers are asked directly, BEFORE anything is fetched from the page itself.
  // For YouTube this is the difference between working and not: its og: tags sit past
  // half a megabyte of inline script, while its oEmbed endpoint answers in under a
  // kilobyte. See `oembedEndpointFor`.
  const endpoint = oembedEndpointFor(url);
  if (endpoint) {
    const oembed = await fetchOEmbed(endpoint, url, signal);
    if (oembed?.title) return pageRecord(url, oembed, {});
    // Fall through and scrape. A provider can be down, or rate-limiting us, or have
    // retired an endpoint — none of which should mean no preview at all.
  }

  const res = await safeRequest(url, { signal });
  if (res.status !== 200) {
    res.stream.destroy();
    return unavailable(raw);
  }

  const kind = kindForContentType(res.contentType);
  if (kind === null) {
    res.stream.destroy();
    return unavailable(raw);
  }

  // Direct media: the URL IS the content, so there's nothing to scrape. For an image we
  // read a header's worth to learn its dimensions — see `imageDimensions` for why that
  // matters more than it looks — and for video/audio we stop at the headers, since the
  // client asks the proxy for the bytes and only if it actually renders it.
  if (kind !== 'page') {
    const size = kind === 'image' ? await imageDimensions(res) : null;
    res.stream.destroy();
    return {
      url: url.toString(),
      status: 'ok',
      kind,
      title: null,
      description: null,
      siteName: null,
      author: null,
      imageUrl: url.toString(),
      imageWidth: size?.width ?? null,
      imageHeight: size?.height ?? null,
      embedUrl: null,
      mime: res.contentType,
      expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    };
  }

  // Buffered off the response we already have, rather than re-requesting: a second GET for
  // the body doubled every page fetch, and doubled the chance of a rate limit on a host we
  // want to stay welcome at. `stopAtHeadEnd` means a well-formed page costs its head only.
  const buffered = await bufferStream(res, {
    maxBytes: MAX_SCRAPE_BYTES,
    stopAtHeadEnd: true,
  });
  return await resolveScrapedPage(buffered.finalUrl, buffered.body, buffered.charset, signal);
}

/**
 * Resolve one URL to a cached-or-fresh preview record.
 *
 * Never throws. Every failure path — malformed URL, blocked address, timeout,
 * 403, unusable content type — becomes an `unavailable` record, which is a real
 * cacheable answer rather than an error to handle. That's what keeps a dead link
 * in old scrollback from reopening a socket every time someone scrolls past it.
 */
export async function resolvePreview(raw: string): Promise<PreviewRecord> {
  // The flag first, before even a cache read: "off" means the feature isn't participating, not
  // that it serves stale answers it happens to still have. The routes aren't mounted either —
  // this is the inner half of the same decision.
  if (!previewsEnabled()) return unavailable(raw, transientTtl());
  // Refused before it can be hashed, stored, or echoed. Nothing downstream caps a URL's
  // length, and this one arrived in a request body. A stable verdict, so it keeps the ordinary
  // failure TTL — a URL this long will still be this long in an hour.
  if (raw.length > MAX_URL_LENGTH) return unavailable(raw);

  // ⚠ Guarded, because the route's contract — and this function's own docblock — is that it
  // never throws, and better-sqlite3 is synchronous on the one shared connection this process
  // has. A single SQLITE_BUSY (a documented condition here under Litestream) would otherwise
  // reject the whole `Promise.all` and 500 an entire 20-URL batch, where the design calls for
  // one URL to degrade to `unavailable` on its own.
  const cached = readCache(raw);
  // ⚠ Re-stamped with the URL as ASKED, not as stored. The row is keyed with the fragment
  // stripped so `#intro` and `#appendix` of one document share a fetch — which means the `url`
  // column holds whichever of them arrived first. Returning that verbatim is the same
  // client-side miss that echoing a post-redirect URL caused (the client looks a preview up by
  // the string it sent), except reached through the cache rather than through a redirect, and
  // only for the second reader onward — so it renders correctly for whoever resolved it and
  // silently for nobody else.
  if (cached) return { ...cached, url: raw };

  // ⚠ Keyed by the STORAGE identity, not by the request string, and re-stamped on the way out
  // for the same reason the cache read above is. Keyed by `raw`, two anchors of one document
  // arriving in the same batch — which is exactly how anchors arrive — coalesced with nothing
  // and cost two fetches of the same page, quietly undoing the fragment collapse the cache key
  // exists to provide.
  const key = urlHash(raw);
  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), url: raw };

  const task = (async (): Promise<PreviewRecord> => {
    // ⚠ `acquired` and the try must wrap EVERYTHING, including the give-up path. An earlier
    // version returned before entering the try, so `finally` never ran and the resolved
    // `unavailable` promise stayed pinned in `inFlight` for the life of the process — every
    // later request for that URL replayed it via the `if (pending)` short-circuit above, never
    // consulting the DB cache again. That's permanent blankness, which is precisely what the
    // "deliberately not cached" note below was trying to avoid.
    let acquired = false;
    // Tears the fetch down if the deadline fires, so the slot released below is genuinely free.
    const controller = new AbortController();
    try {
      acquired = await pool.acquire();
      if (!acquired) {
        // Deliberately NOT cached, at either end: this says nothing about the URL, only that
        // the instance was saturated when we asked. No row here, and a short `expiresAt` so a
        // client honouring the field re-asks in seconds — see TRANSIENT_TTL_MS, because keeping
        // it out of OUR cache while telling the client to hold it for an hour achieved nothing.
        return unavailable(raw, transientTtl());
      }
      // ⚠ The deadline ABORTS the work, it doesn't merely stop waiting for it. Racing a promise
      // abandons it, and abandoning is not ending: the fetch kept its socket for its own hop
      // budget — up to minutes — while the `finally` below handed its pool slot to somebody
      // else. So the pool undercounted its own work, and under a run of slow origins more than
      // MAX_CONCURRENT fetches were live at once, without bound. A cap that a timeout quietly
      // lifts is not a cap.
      const resolved = await withDeadline(
        doResolve(raw, controller.signal),
        RESOLVE_DEADLINE_MS,
        'resolve',
      );
      // ⚠ Always echo the URL we were ASKED about, whatever the fetch ended up at.
      //
      // The endpoint's contract is one descriptor per input, in order, and callers look each
      // one up by the string they sent. Returning a post-redirect URL broke that silently in
      // both directions: the client's `cache.get(preview.url)` missed, so nothing ever
      // rendered, and `putPreview` wrote a row keyed by something no lookup would ever ask
      // for, so every resolve re-hit the origin. The canonical URL is still used internally
      // where it matters — resolving a relative og:image against the page we actually landed
      // on — it just isn't the identity.
      const record = { ...resolved, url: raw };
      writeCache(record);
      return record;
    } catch (err) {
      // ⚠ Running out of time is NOT a verdict about the URL — the origin was slow, which is a
      // fact about a moment. Cached, it would blank a perfectly good link for an hour on the
      // strength of one bad afternoon. Same treatment as pool saturation: no row, short TTL.
      if (err instanceof DeadlineExceeded) {
        controller.abort();
        return unavailable(raw, transientTtl());
      }
      // An SSRF refusal is worth a line — it's either a misconfigured link or
      // somebody probing. Everything else (timeouts, resets, 403s) is ordinary
      // internet weather and would only be log noise.
      if (err instanceof UnsafeUrlError) {
        console.warn(`[lurker] link preview refused: ${err.message}`);
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
  return await task;
}

/** The wire shape handed to clients. Byte URLs are minted here, so a client
 *  never learns to construct one — see mediaProxyToken. */
export interface PreviewDescriptor {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewKind;
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
  // a cache row — so what's asserted here isn't "did videoEmbedFor behave", it's "whatever is
  // in the row, we only ever hand clients an origin we're willing to frame". There is still no
  // CSP anywhere in this repo, so this check is the frame-src.
  if (record.embedUrl && isEmbeddableOrigin(record.embedUrl)) {
    d.embedUrl = record.embedUrl;
  } else if (record.kind === 'video-embed') {
    // ⚠ Withholding the URL but keeping `kind: 'video-embed'` describes something that cannot
    // exist — a client renders a play button wired to nothing. The honest downgrade is a page
    // card, which is what it now is.
    d.kind = 'page';
  }

  if (record.imageUrl) {
    // ⚠⚠ A CACHED object is served from its own public URL, and only the mint site
    // knows that. `src`/`thumb` are opaque to every client — nothing constructs one,
    // nothing parses one — so substituting a CDN URL for a proxy path here is
    // invisible on the wire and costs no protocol change, no version bump and no
    // client release. It is also the reason the byte cache has no redirect: a 302
    // would spend a round trip through the cell to say what this already knows, and
    // would hand a third-party host whatever `Authorization` header the client had
    // set on the original request.
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
    if (record.kind === 'image' || record.kind === 'video' || record.kind === 'audio') {
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
  }
  return d;
}

/** Ceiling on preview IMAGE bytes the proxy will serve. */
export const MAX_IMAGE_PROXY_BYTES = 8 * 1024 * 1024;
/** Ceiling on VIDEO/AUDIO bytes. Larger because these stream to a media element rather than
 *  being decoded whole — an 8 MB cut-off truncated ordinary clips mid-playback. */
export const MAX_MEDIA_PROXY_BYTES = 64 * 1024 * 1024;

/**
 * Whether the byte proxy will serve this content type.
 *
 * ⚠ Derived from `kindForContentType` rather than restated. The route had its own copy of the
 * same allowlist, which meant the refusal that matters most — `image/svg+xml`, a scripting
 * format wearing a picture's clothes, served under OUR origin — existed in two places that had
 * to be kept in step by hand. One definition, and the proxy serves exactly the kinds the
 * resolver is willing to call media.
 */
export function proxyableContentType(contentType: string): boolean {
  const kind = kindForContentType(contentType);
  return kind === 'image' || kind === 'video' || kind === 'audio';
}
