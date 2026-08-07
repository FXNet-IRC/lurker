// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Two endpoints, both authenticated:
//
//   POST /api/link-preview/resolve      urls[] → descriptors[]
//   GET  /api/link-preview/media/:token → the bytes, streamed
//
// REST rather than WebSocket because these are reads, and Lurker's reads are
// REST (search is the one deliberate exception, and it's deliberate because it
// needs a token/reply round trip the REST surface can't express). The byte
// endpoint has to be a URL regardless — that's what an <img src> is.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { RequestThrottle } from '../middleware/rateLimit.js';
import {
  byteCacheKey,
  beginStore,
  cacheEnabled,
  cacheable,
  lookup,
  trackPendingStore,
} from '../services/previewCache/index.js';
import {
  resolvePreview,
  toDescriptor,
  proxyableContentType,
  MAX_IMAGE_PROXY_BYTES,
  MAX_MEDIA_PROXY_BYTES,
  MAX_URLS_PER_REQUEST,
} from '../services/linkPreview.js';
import { verifyProxyToken } from '../services/mediaProxyToken.js';
import { normalizeUrl, safeRequest } from '../services/linkFetch.js';
import { previewsEnabled } from '../utils/previews.js';
import { cooldownRemaining, isTransientStatus, noteRefusal } from '../utils/originCooldown.js';
import { SlotPool } from '../utils/slotPool.js';

const router = Router();
router.use(requireAuth);

/**
 * Per-account cap on resolutions.
 *
 * Keyed by user rather than by IP, unlike the auth limiters: this route is
 * authenticated, so the account is the accurate identity, and an IP key would
 * lump everyone behind one household NAT together. The ceiling is set for a
 * human scrolling fast through link-heavy scrollback — clients batch and dedupe
 * before asking, so hitting this means something is looping.
 */
const resolveThrottle = new RequestThrottle({
  windowMs: 60_000,
  maxRequests: 120,
});

/**
 * Per-account cap on BYTE requests.
 *
 * ⚠ The byte endpoint needs its own. Only `/resolve` was throttled, so any authenticated session
 * could loop `GET /media/:token` for a token it already held: keep-alive is off by design, so
 * each request opens a fresh upstream socket and pulls up to the cap — a few hundred in flight
 * saturate the cell's egress and file descriptors and hammer the origin from the operator's IP,
 * which is the exact resource the resolve throttle exists to protect.
 *
 * Set well above what a person browsing generates (the browser and iOS URLCache hold these for a
 * day, so a re-scroll costs nothing) and far below what a loop does.
 */
const mediaThrottle = new RequestThrottle({ windowMs: 60_000, maxRequests: 300 });

/**
 * The response headers every byte answer carries, live or cached.
 *
 * ⚠⚠ Extracted rather than duplicated, and that is the point. These are the
 * security headers that keep a third party's bytes from being interpreted as
 * anything but the media type we allowlisted, and the cache added a SECOND way to
 * send a response body. Two copies would drift, and the copy that drifts is the
 * one nobody looks at — a cached image served without `nosniff` is the same
 * vulnerability as an uncached one, arrived at by omission.
 */
function applyMediaHeaders(res: Response, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  // Belt and braces against the response being interpreted as anything other
  // than the media type we just allowlisted.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // No filename: it would come from a URL someone else controls.
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // The token is a pure function of the URL, so a given token always denotes
  // the same bytes — safe to cache hard, and it's what keeps a scroll through
  // an image-heavy channel from re-proxying on every pass. `private` because
  // the response travels over an authenticated session.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
}

/**
 * Byte fetches in flight across the whole instance.
 *
 * ⚠ Its OWN pool, and not optional. The resolver's pool documents itself as the bound on the
 * feature's outstanding DNS lookups — `getaddrinfo` runs on libuv's thread pool and cannot be
 * cancelled, so a destroyed request keeps its slot for the full OS timeout, and the other DNS
 * consumer on this server is IRC connection setup. This route never went through that pool, and
 * it is the HIGHER-volume half: one resolve per link, but one byte request per image on screen.
 * `mediaThrottle` bounds the rate and not the concurrency, and the agents are deliberately
 * `keepAlive: false, maxSockets: Infinity`, so a session replaying tokens it already holds could
 * open sockets and uncancellable lookups without limit.
 *
 * Separate from the resolver's rather than shared with it because the two have opposite
 * profiles: a metadata fetch is a sub-second burst, a byte fetch can hold its slot for the
 * length of a video. Sharing would let one video stall every preview on the instance.
 *
 * ⚠ That same argument applies WITHIN this pool, and is not addressed here: a thumbnail and a
 * 64 MB video share these slots, so a handful of streams can make every image on the instance
 * queue. Two mitigations rather than a second pool (which would need the kind before the
 * headers that reveal it): MAX_TRANSFER_MS bounds how long any one slot can be held, and the
 * wait is short — an <img> that can't get a slot should fail in three seconds and be retried by
 * the page, not stall for ten and then get a 503 that <img> treats as permanent.
 */
const mediaPool = new SlotPool({ size: 24, maxQueued: 200, waitMs: 3_000 });

/**
 * Ceiling on one proxied transfer, start to finish.
 *
 * ⚠ `streaming: true` clears HOP_DEADLINE_MS, which is the only bound in the fetcher that a
 * byte cannot reset — deliberately, because it cut healthy video at 20 s. But that left this
 * route with NO total-time bound: an origin dribbling one byte every 25 s resets the idle timer
 * forever, never reaches the 64 MB counter, and holds a pool slot indefinitely. The resolver
 * got RESOLVE_DEADLINE_MS in the same change; this is the other half of it.
 *
 * Generous on purpose — 64 MB inside five minutes is ~1.8 Mbit/s, well under any real
 * server-to-origin link — so it bounds abuse without cutting a slow-but-genuine transfer.
 */
const MAX_TRANSFER_MS = 5 * 60_000;

/**
 * Total size of the resource a `Content-Range` describes.
 *
 * Returns a number, `'unknown'` when the origin legitimately doesn't say (`bytes 0-N/*`, which
 * RFC 7233 §4.2 allows), or `'unusable'` for anything we can't make sense of.
 *
 * ⚠ Three ways the first version let the cap be walked past, and the shape of two of them is
 * worth keeping in mind: **the more absurd the claim, the more permissive the answer.**
 *   - `bytes 0-N/*` matched nothing (the pattern demanded digits), so an origin that declines
 *     to state a size got waved through.
 *   - A 400-digit total made `Number()` return `Infinity`, `Number.isFinite` false, and the
 *     guard conclude "no total, carry on". Now it fails CLOSED.
 *   - `$`-anchoring read only the last of a duplicated header, which node joins with a comma.
 */
function contentRangeTotal(header: string | undefined): number | 'unknown' | 'unusable' {
  if (!header) return 'unknown';
  // node joins duplicate headers with ', '. Judge the FIRST — an origin repeating itself gets
  // read the way a client would read it, not the way an attacker would prefer.
  const first = header.split(',')[0];
  const slash = first.lastIndexOf('/');
  if (slash === -1) return 'unusable';
  const total = first.slice(slash + 1).trim();
  if (total === '*') return 'unknown';
  if (!/^\d+$/.test(total)) return 'unusable';
  const n = Number(total);
  // Past 2^53 the digits are real but the number isn't; a length we can't represent is a
  // length we refuse rather than one we ignore.
  return Number.isSafeInteger(n) ? n : 'unusable';
}

router.post('/resolve', async (req: Request, res: Response) => {
  // Same inner gate as the byte route. The router isn't mounted when the feature is off, so
  // this is unreachable in a running server — but both endpoints answering the flag the same
  // way is what keeps that true if the mounting ever moves.
  if (!previewsEnabled()) {
    res.status(404).end();
    return;
  }

  // ⚠ `?? {}`, because Express 5's body-parser leaves `req.body` UNDEFINED rather than empty
  // for any request that isn't JSON — no Content-Type, `text/plain`, a form post. Reading
  // through it threw a TypeError into the error middleware, so the 400 two lines down was
  // dead code for precisely the malformed requests it exists to answer, and a client sending
  // the wrong content type got a 500 and a logged stack instead of being told what was wrong.
  const body = (req.body ?? {}) as { urls?: unknown };
  if (!Array.isArray(body.urls)) {
    res.status(400).json({ error: 'urls must be an array' });
    return;
  }

  const urls = body.urls
    .filter((u): u is string => typeof u === 'string')
    .slice(0, MAX_URLS_PER_REQUEST);

  const verdict = resolveThrottle.allow(String(req.user!.id));
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    res.status(429).json({ error: 'too many preview requests — slow down' });
    return;
  }

  // Resolved in parallel, but `resolvePreview` never rejects and coalesces
  // duplicates internally, so this can't turn into an unbounded fan-out or an
  // unhandled rejection.
  const previews = await Promise.all(urls.map(async (u) => toDescriptor(await resolvePreview(u))));
  res.json({ previews });
});

router.get('/media/:token', async (req: Request, res: Response) => {
  if (!previewsEnabled()) {
    res.status(404).end();
    return;
  }

  const verdict = mediaThrottle.allow(String(req.user!.id));
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    res.status(429).json({ error: 'too many media requests — slow down' });
    return;
  }

  // The token is the capability: the server minted it during resolve, after the
  // URL had already passed the guard, so a client can only replay a decision we
  // made. It cannot author one.
  const raw = verifyProxyToken(String(req.params.token));
  if (!raw) {
    res.status(403).end();
    return;
  }

  // Re-vetted from scratch anyway. The token proves we approved this URL at some
  // point; it says nothing about where the name points NOW, and a DNS record
  // that was public an hour ago can be 10.0.0.5 today. safeRequest re-runs the
  // pinned lookup on every hop.
  const url = normalizeUrl(raw);
  if (!url) {
    res.status(403).end();
    return;
  }

  // ⚠ The cache is consulted before the fetch, but NOT before the pool. An
  // earlier version returned a hit ahead of `mediaPool.acquire()` on the
  // reasoning that a hit does no outbound work — true of sockets and DNS, and
  // inverted for memory. A hit reads the whole object into RSS, so bypassing the
  // only concurrency bound let one session at the 300/min throttle ceiling park
  // ~300 x 8 MB while the pool sat idle, and it got WORSE the warmer the cache
  // was. The pool bounds a resource the cache also spends.
  const isRange = typeof req.headers.range === 'string' && req.headers.range !== '';
  const cacheKey = byteCacheKey(url.toString());

  // ⚠⚠ A host that just rate-limited us is not asked again until it says we may.
  // Measured on a real instance: `opengraph.githubassets.com` — where every
  // GitHub link's og:image lives — advertises a budget of 100 in `x-ratelimit-*`,
  // and a channel with a run of GitHub links spends it in one burst from the
  // instance's single IP. Without this, every later view of every one of those
  // images went out and asked again, so the budget never recovered.
  //
  // ⚠ Checked BEFORE the pool, deliberately, unlike the cache read below. The
  // whole point is to spend nothing — not a slot, not a socket, not a DNS
  // lookup — on a request we already know the answer to. The cache read is
  // inside the pool because a hit costs memory; this costs a map lookup.
  //
  // ⚠ 503, never 404. Same reasoning the saturation branch spells out: an <img>
  // treats 404 as permanent and never re-asks, so reporting a temporary refusal
  // that way turns a minute of rate limiting into a blank image forever.
  const cooling = cooldownRemaining(url.hostname);
  if (cooling > 0) {
    res.set('Retry-After', String(cooling));
    res.status(503).end();
    return;
  }

  if (!(await mediaPool.acquire())) {
    // Saturated, not broken. 503 + Retry-After so a media element backs off and retries,
    // rather than 404, which an <img> treats as a permanent verdict and never re-asks.
    res.set('Retry-After', '5');
    res.status(503).end();
    return;
  }

  // ⚠ Registered BEFORE the fetch is awaited, and it owns the slot release.
  //
  // Attaching this after `await safeRequest(...)` — which can take the full hop deadline —
  // meant a client that aborted during the fetch had already fired `close`, so the listener
  // written to stop us "holding a socket to the origin" was attached to an event that would
  // never fire again. Writes then fail silently while the byte counter below keeps the
  // upstream in flowing mode, so the whole body drains to the origin's end with nobody to
  // send it to: connect-then-abort as a cheap amplifier.
  //
  // `close` on a response fires whether it finished or aborted, which makes it the one place
  // that always runs — so it is also where the pool slot goes back.
  // ⚠⚠ The abort is what makes this work, and its absence is what made the previous version
  // a comment rather than a teardown: `finish()` latched `done = true` while `upstream` was
  // still null, so on the abort-during-fetch path — the one this whole block exists for — the
  // `upstream?.stream.destroy()` it was written to perform could never run, and the later
  // `finish()` returned at its own guard. The origin socket was left live and unread, outside
  // a pool that had already counted it as free. Aborting the CONTROLLER covers the window
  // before there is a stream to destroy; this route was also the one `safeRequest` caller
  // that never passed a signal, in the same diff that added signals for exactly this reason.
  const controller = new AbortController();
  let upstream: Awaited<ReturnType<typeof safeRequest>> | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(transferDeadline);
    controller.abort();
    upstream?.stream.destroy();
    mediaPool.release();
  };
  // Bounds slot occupancy even when nothing else will — see MAX_TRANSFER_MS. Tearing the
  // response down routes through `release` via `close`, so there is still one release path.
  const transferDeadline = setTimeout(() => {
    upstream?.stream.destroy();
    res.destroy();
  }, MAX_TRANSFER_MS);
  transferDeadline.unref();

  res.on('close', release);
  // A response already gone by the time we got a slot never emits `close` again.
  if (res.destroyed) {
    release();
    return;
  }

  // ⚠ Inside the pool, and after `release` is wired to the response's `close`, so
  // a hit gives its slot back the same way a fetch does. `lookup` never throws —
  // that is this module's headline promise, and it was a claim before it was true:
  // `lookupCached` takes a WAL write lock for its `last_access` touch, and a
  // SQLITE_BUSY thrown from here used to escape a `try` that had not opened yet
  // and 500 an image request that would have succeeded with caching off.
  if (cacheEnabled() && !isRange) {
    const hit = await lookup(cacheKey);
    if (hit) {
      applyMediaHeaders(res, hit.contentType);
      res.setHeader('Content-Length', String(hit.body.length));
      res.status(200).end(hit.body);
      return;
    }
  }

  try {
    upstream = await safeRequest(url, {
      accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5',
      // Forwarded so inline video works at all. Safari (iOS and macOS) refuses to play a
      // <video> whose source doesn't honour byte ranges, and seeking is broken everywhere
      // without it — and this route is what serves `kind === 'video'`.
      range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
      // Piped, not buffered: the scrape-tuned deadlines cut a healthy media transfer at 20 s
      // and read a backpressured <video> as a dead origin. See FetchOptions.streaming.
      streaming: true,
      // So giving up actually ends the fetch. Without it the release above frees a slot while
      // the request is still dialling — including an uncancellable lookup — which is the
      // undercount this pool exists to prevent.
      signal: controller.signal,
    });
    // The client left, or the stream died, while we were awaiting. Without this the response
    // never gets its `end()` — and `Content-Length` may already have gone out — so the
    // browser hangs on a half-open response with no error to show.
    if (released || res.destroyed || upstream.stream.destroyed) {
      // ⚠ Destroyed HERE, not delegated to `release()`. If the client left during the fetch,
      // `release()` has already run and latched — calling it again returns at its own guard
      // and the stream we have only just been handed stays open, unread, until an idle
      // timeout the streaming flag has already loosened to 30 s.
      upstream.stream.destroy();
      release();
      return;
    }

    // 206 is a success here: it's what a range request is asking for. 416 is the origin
    // telling the client its range is unsatisfiable, which is an answer the media element
    // knows how to act on — passing it through as 404 makes an unsatisfiable seek look like
    // a missing file.
    if (upstream.status === 416) {
      upstream.stream.destroy();
      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', String(upstream.headers['content-range']));
      }
      res.status(416).end();
      return;
    }
    const ok = upstream.status === 200 || upstream.status === 206;
    if (!ok || !proxyableContentType(upstream.contentType)) {
      upstream.stream.destroy();
      // ⚠⚠ "Not now" and "not ever" are different answers, and collapsing them
      // into 404 is what made a GitHub rate limit look like a missing image.
      // An <img> treats 404 as a permanent verdict — the browser never re-asks,
      // so a minute of 429s became a blank card that no reload could repair.
      // ⚠ Only the STATUS gets this treatment. A content type we refuse to proxy
      // is a fact about the URL and stays a 404 however many times it is asked.
      if (ok || !isTransientStatus(upstream.status)) {
        res.status(404).end();
        return;
      }
      // The host's own instruction is preferred over any guess we could make —
      // `Retry-After` in either legal form, else `x-ratelimit-reset`.
      noteRefusal(url.hostname, upstream.headers);
      res.set('Retry-After', String(cooldownRemaining(url.hostname) || 60));
      res.status(503).end();
      return;
    }
    // ⚠⚠ NOTHING clears the hold on success, and that is deliberate — an earlier
    // version called `noteSuccess` here and it was both dead and harmful. Dead,
    // because an active hold short-circuits above and no fetch can reach this
    // line while one is armed. Harmful, because the one interleaving that DOES
    // reach it is the burst this exists to damp: two dozen requests go out
    // together, several are refused and arm the hold, and a single success then
    // tears it down before it can stop anything. The hold expires on its own
    // clock, which is short by design.
    // ⚠ Per-KIND cap. The single 8 MB ceiling was named for images and silently applied to
    // everything, so a 30 MB mp4 rendered inline was streamed to 8 MB and then had both ends
    // destroyed — the <video> died with a network error partway through, and since the
    // `immutable` Cache-Control had already gone out the browser could cache the truncated
    // body. Video and audio are streamed to a media element and are legitimately larger.
    const cap = upstream.contentType.startsWith('image/')
      ? MAX_IMAGE_PROXY_BYTES
      : MAX_MEDIA_PROXY_BYTES;
    const declared = Number(upstream.headers['content-length']);
    // ⚠ On a 206 the declared length is the length of the PART, so checking it alone let the
    // cap be walked straight past: a client asking for a gigabyte 1 MB at a time satisfies
    // `declared <= cap` every single time. The resource's real size is the figure after the
    // slash in Content-Range, and that is what the cap is about.
    const total = contentRangeTotal(upstream.headers['content-range'] as string | undefined);
    const oversize =
      (Number.isFinite(declared) && declared > cap) ||
      total === 'unusable' ||
      (typeof total === 'number' && total > cap);
    if (oversize) {
      upstream.stream.destroy();
      res.status(413).end();
      return;
    }

    applyMediaHeaders(res, upstream.contentType);

    // Range plumbing, so a media element can seek. ⚠ Only claimed when the origin actually
    // demonstrated it: advertising `Accept-Ranges: bytes` for a source that ignores Range
    // makes a media element seek by requesting a range and then silently receive the whole
    // file from byte zero, which reads as a seek that jumps back to the start.
    // ⚠ A TOKEN match. node joins a duplicated header, so a range-capable origin that sends
    // `Accept-Ranges: bytes` twice arrives as `'bytes, bytes'` and an equality test calls it
    // range-incapable — at which point Safari refuses to play the <video> at all, silently:
    // the card renders, the video just never starts.
    const upstreamRanges =
      upstream.status === 206 ||
      String(upstream.headers['accept-ranges'] || '')
        .toLowerCase()
        .split(',')
        .some((token) => token.trim() === 'bytes');
    if (upstreamRanges) res.setHeader('Accept-Ranges', 'bytes');
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', String(upstream.headers['content-range']));
    }

    // ⚠ Content-Length is only forwarded when we KNOW we'll send exactly that many bytes.
    // Echoing it verbatim while the body was truncated at the cap produced a length/body
    // mismatch — the client saw ERR_HTTP_CONTENT_LENGTH_MISMATCH (a broken transfer) rather
    // than a clean, cacheable failure.
    if (Number.isFinite(declared) && declared <= cap) {
      res.setHeader('Content-Length', String(declared));
    }
    res.status(upstream.status === 206 ? 206 : 200);

    // ⚠⚠ STREAMED to the cache, never buffered. Collecting the object first cost a
    // copy in `chunks` plus a second at `Buffer.concat`, and the per-request 8 MB
    // ceiling multiplied by mediaPool's 24 slots — ~192 MB steady state, ~384 MB
    // transient, memory the uncached path never allocated, reachable by anyone
    // authenticated opening 24 concurrent large images. The destination is a file,
    // so there was never a reason for the bytes to sit in RSS on the way there.
    //
    // ⚠ `declared` when the origin gave one, the cap when it did not: the writer
    // reserves room before the first byte, and under-reserving is how the ceiling
    // gets crossed.
    const wantCache = cacheable(upstream.contentType, isRange) && upstream.status !== 206;
    const writer = wantCache
      ? await beginStore(cacheKey, Number.isFinite(declared) ? declared : cap)
      : null;
    // Registered only once there is something to decide; settled on every exit
    // below. Only a test waits on it — see `trackPendingStore`.
    const settleDecision = writer ? trackPendingStore() : null;

    // Enforce the cap on bytes actually seen, not on the declared length — an
    // origin can omit Content-Length or lie about it.
    let sent = 0;
    const stream = upstream.stream;
    stream.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > cap) {
        stream.destroy();
        res.destroy();
        return;
      }
      writer?.write(chunk);
    });
    stream.on('error', () => res.destroy());

    // ⚠⚠ `end` is what means "the origin sent a COMPLETE object", and it is the only
    // thing that may authorise a store. A body cut short is still a stream of real
    // bytes — cached, it becomes a permanently broken image served to everyone
    // afterwards and held by their browsers for a day. `close` fires either way,
    // which is why it cannot be the trigger, and why this is latched rather than
    // inferred afterwards.
    let ended = false;
    stream.on('end', () => {
      ended = true;
    });

    // ⚠ DECIDED on `close`, because that is the one event guaranteed to fire on
    // every path — finished, destroyed by the cap, or aborted by the client — so
    // the decision is always settled and never left dangling.
    stream.on('close', () => {
      if (!writer) return;
      // ⚠⚠ THE BODY MUST BE FRAMED, and `ended` alone does not prove it. Node emits
      // `end` — with `complete` true — for a body framed only by the connection
      // closing, because to the protocol a closed connection IS the terminator: a
      // truncated one is indistinguishable from a finished one. This route makes
      // that the common case rather than an exotic one, since `linkFetch` runs its
      // agents `keepAlive: false` and every request therefore carries
      // `Connection: close` — exactly the condition RFC 7230 §3.3.3 lets an origin
      // omit framing under.
      //
      // ⚠ Chunked counts as framed: a chunked body cut short does NOT emit `end` —
      // node raises `aborted` and leaves `complete` false — so `ended` already
      // proves completeness there. Requiring a Content-Length outright would have
      // refused to cache every chunked origin, which is a great many of them, to
      // fix a hazard chunked does not have.
      const chunked = String(upstream!.headers['transfer-encoding'] ?? '')
        .toLowerCase()
        .includes('chunked');
      const framed = chunked || (Number.isFinite(declared) && declared === sent);
      if (!ended || !framed || sent > cap) {
        void writer.abort().finally(() => settleDecision?.());
        return;
      }
      // Deliberately not awaited: the reader already has their bytes, and a slow
      // disk must not hold the response open. Failures are the cache's own problem
      // — the writer swallows them and simply stays a miss.
      void writer
        .commit(upstream!.contentType)
        .catch(() => {})
        .finally(() => settleDecision?.());
    });
    stream.pipe(res);
  } catch {
    // Blocked address, timeout, reset — all the same to a caller waiting on an
    // image, and none of them worth distinguishing in a status code.
    release();
    if (!res.headersSent) res.status(404).end();
  }
});

export default router;
