// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver's cell-side half: identity, caching, TTL policy and descriptor
// minting, exercised against a contract-faithful decoder stub.
//
// The origin-facing behaviour that used to be tested here and in the old
// origin-test file — the scrape, entity decoding, charsets, dimension
// measurement, `pageRecord`'s give-up ladder — MOVED to the lurker-previews repo
// with the code (its resolve.test.ts / resolve.origin.test.ts). What this file
// pins is everything the move left behind: that a verdict becomes the right
// record with the right lifetime, that identity is the URL as asked, and that a
// moment is never cached as a verdict.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';
import { verifyPosterToken } from './mediaProxyToken.js';
import type { PreviewRecord } from '../db/linkPreviews.js';

const ctx = setupTestDb('link-preview-service');

let resolvePreview: typeof import('./linkPreview.js').resolvePreview;
let toDescriptor: typeof import('./linkPreview.js').toDescriptor;
let getCachedPreview: typeof import('../db/linkPreviews.js').getCachedPreview;
let putPreview: typeof import('../db/linkPreviews.js').putPreview;
let OK_TTL_MS: number;
let FAIL_TTL_MS: number;
let stub: StubDecoder;

beforeAll(async () => {
  // startStubDecoder sets LURKER_PREVIEWS_URL, which IS the feature gate — so previews are on.
  stub = await startStubDecoder();
  ({ getCachedPreview, putPreview, OK_TTL_MS, FAIL_TTL_MS } =
    await import('../db/linkPreviews.js'));
  ({ resolvePreview, toDescriptor } = await import('./linkPreview.js'));
});

afterAll(async () => {
  await stub.close();
  ctx.cleanup();
});

beforeEach(() => {
  stub.onResolve = () => ({ status: 'dead' });
  stub.resolveAsks.length = 0;
});

/** A complete `ok` record, so a test can vary the one field it cares about. */
function record(over: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    url: 'https://example.com/a',
    status: 'ok',
    kind: 'page',
    title: 'A Title',
    description: 'A description',
    siteName: 'Example',
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: null,
    posterKey: null,
    expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    ...over,
  };
}

const A_POSTER_KEY = 'c'.repeat(64);

describe('toDescriptor', () => {
  it('proxies a page thumbnail and never leaks the origin URL', () => {
    const d = toDescriptor(record({ imageUrl: 'https://cdn.example.com/t.png', imageWidth: 800 }));
    expect(d.thumb).toMatch(/^\/api\/link-preview\/media\//);
    expect(d.src).toBeUndefined();
    expect(d.thumbWidth).toBe(800);
    expect(JSON.stringify(d)).not.toContain('cdn.example.com');
  });

  it('puts a direct IMAGE in src, because the bytes ARE the content', () => {
    const d = toDescriptor(record({ kind: 'image', imageUrl: 'https://cdn.example.com/a.png' }));
    expect(d.src).toMatch(/^\/api\/link-preview\/media\//);
    expect(d.thumb).toBeUndefined();
  });

  // ⚠⚠ The media-policy change, and the reason it is asserted on BOTH fields: an earlier shape
  // of this could plausibly have demoted video to `thumb` rather than dropping it, which would
  // have rendered a card with a 44 MB "thumbnail" — the relay this exists to end, wearing a
  // different field name. Neither slot may carry a byte URL for these kinds.
  it('gives video and audio NO byte url at all, in either slot', () => {
    for (const kind of ['video', 'audio'] as const) {
      const d = toDescriptor(record({ kind, imageUrl: 'https://cdn.example.com/a.mp4' }));
      expect(d.src).toBeUndefined();
      expect(d.thumb).toBeUndefined();
      // The card still has to be drawable: the origin URL and the measured type survive.
      expect(d.url).toBe('https://example.com/a');
      expect(d.kind).toBe(kind);
    }
  });

  // ⚠ The whole descriptor, not just the two byte fields. `mintProxyToken` is an HMAC of the
  // URL, so a leak here would be a token that still resolves — and the point of withholding
  // `src` is that nothing reaches the client that a player could be pointed at.
  it('leaks no proxy path anywhere in a video descriptor', () => {
    const d = toDescriptor(record({ kind: 'video', imageUrl: 'https://cdn.example.com/a.mp4' }));
    expect(JSON.stringify(d)).not.toContain('/api/link-preview/media/');
  });

  it('mints a POSTER thumb for a video that has one stored', () => {
    // The poster is the media policy's other half: the clip is never relayed, but a first
    // frame this instance decoded and stored is a card decoration like any page thumb —
    // served from its own route because it has no origin URL to fall back to.
    const d = toDescriptor(
      record({
        kind: 'video',
        imageUrl: 'https://cdn.example.com/a.mp4',
        posterKey: A_POSTER_KEY,
        imageWidth: 640,
        imageHeight: 360,
      }),
    );
    // ⚠ A SIGNED token, not the bare key — the whole of the poster route's security, since the
    // key is an unsalted hash a client can compute. The path carries a token that round-trips
    // back to exactly this poster key and to no other.
    expect(d.thumb).toMatch(/^\/api\/link-preview\/poster\/.+\..+$/);
    const token = d.thumb!.slice('/api/link-preview/poster/'.length);
    expect(verifyPosterToken(token)).toBe(A_POSTER_KEY);
    // ...and the bare key never appears in the descriptor, or the signature bought nothing.
    expect(JSON.stringify(d)).not.toContain(A_POSTER_KEY);
    // For these rows the stored dimensions describe the POSTER — the box the client reserves.
    expect(d.thumbWidth).toBe(640);
    expect(d.thumbHeight).toBe(360);
    // Still no src, and still nothing a player could be pointed at.
    expect(d.src).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('/api/link-preview/media/');
    expect(JSON.stringify(d)).not.toContain('cdn.example.com');
  });

  it('refuses to mint a poster path from a key that is not a key', () => {
    // ⚠ The row is data — it survived a DB round trip and whatever wrote it. Same posture as
    // embedUrl below: vet on the way OUT, fail closed to a posterless card.
    for (const bad of ['../../../etc/passwd', 'C'.repeat(64), 'abc', `${A_POSTER_KEY}x`]) {
      const d = toDescriptor(record({ kind: 'video', posterKey: bad }));
      expect(d.thumb).toBeUndefined();
    }
  });

  it('withholds thumb dimensions when there is no thumb to describe', () => {
    // ⚠ Emitted outside the imageUrl block, these described a picture that was never sent —
    // so a client reserved a box for nothing, which is the reflow the fields exist to prevent.
    const d = toDescriptor(record({ imageUrl: null, imageWidth: 1200, imageHeight: 630 }));
    expect(d.thumb).toBeUndefined();
    expect(d.thumbWidth).toBeUndefined();
    expect(d.thumbHeight).toBeUndefined();
  });

  it('carries nothing but the verdict when a preview is unavailable', () => {
    const d = toDescriptor(record({ status: 'unavailable', imageUrl: 'https://cdn.test/x.png' }));
    expect(d.status).toBe('unavailable');
    expect(d.title).toBeUndefined();
    expect(d.thumb).toBeUndefined();
    expect(d.src).toBeUndefined();
  });

  it('ships an embedUrl only for an origin we are willing to frame', () => {
    // ⚠ Checked on the way OUT, against the shared allowlist rather than a prefix test — this
    // is the one field a client puts in an <iframe>, and the value arrives from a cache row.
    // `startsWith` would pass `player.vimeo.com.evil.test`, and there is no CSP in this repo.
    // It is also the designed failure mode for the cross-repo provider-table duplication:
    // an embed the decoder builds that this copy doesn't recognise downgrades right here.
    const ok = toDescriptor(
      record({ kind: 'video-embed', embedUrl: 'https://www.youtube-nocookie.com/embed/abc' }),
    );
    expect(ok.embedUrl).toBe('https://www.youtube-nocookie.com/embed/abc');

    for (const bad of [
      'https://player.vimeo.com.evil.test/video/1',
      'https://www.youtube.com/embed/abc',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const d = toDescriptor(record({ kind: 'video-embed', embedUrl: bad }));
      expect(d.embedUrl).toBeUndefined();
      // ...and it stops calling itself a video embed. Withholding the URL while keeping the
      // kind describes something that can't exist: a play button wired to nothing.
      expect(`${bad} → ${d.kind}`).toBe(`${bad} → page`);
    }
  });
});

describe('resolvePreview: verdicts become records with lifetimes', () => {
  it('turns an `ok` into a record with the seven-day TTL and the fields as sent', async () => {
    stub.onResolve = () => ({
      status: 'ok',
      meta: {
        kind: 'page',
        title: 'A Headline',
        description: 'About a thing.',
        siteName: 'News',
        imageUrl: 'https://news.example/card.png',
        imageWidth: 1200,
        imageHeight: 630,
      },
    });
    const url = 'https://news.example/article';
    const rec = await resolvePreview(url);
    expect(rec.status).toBe('ok');
    expect(rec.title).toBe('A Headline');
    expect(rec.imageWidth).toBe(1200);
    expect(rec.url).toBe(url);
    const ttl = new Date(rec.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(FAIL_TTL_MS);
    expect(ttl).toBeLessThanOrEqual(OK_TTL_MS);
    expect(getCachedPreview(url)?.title).toBe('A Headline');
  });

  it('gives a contentless embed the FAILURE ttl, not the seven-day one', async () => {
    // ⚠ Regression guard, relocated from `pageRecord` (which moved to the decoder): a record
    // whose only substance is an embedUrl exists because the provider call that would have
    // filled in title and image JUST FAILED. Caching it for seven days banks one rate-limited
    // minute for a week; `title || imageUrl` is the cell's line between a full card and that
    // degraded one, computed here because the TTLs live here.
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'video-embed', embedUrl: 'https://www.youtube-nocookie.com/embed/abc' },
    });
    const thin = await resolvePreview('https://www.youtube.example/watch?v=abc');
    expect(thin.status).toBe('ok');
    const thinTtl = new Date(thin.expiresAt).getTime() - Date.now();
    expect(thinTtl).toBeLessThanOrEqual(FAIL_TTL_MS);

    stub.onResolve = () => ({
      status: 'ok',
      meta: {
        kind: 'video-embed',
        title: 'A Real Video',
        embedUrl: 'https://www.youtube-nocookie.com/embed/abc',
      },
    });
    const full = await resolvePreview('https://www.youtube.example/watch?v=full');
    const fullTtl = new Date(full.expiresAt).getTime() - Date.now();
    expect(fullTtl).toBeGreaterThan(FAIL_TTL_MS);
    expect(fullTtl).toBeLessThanOrEqual(OK_TTL_MS);
  });

  it('caches `none` and `dead` as the stable verdicts they are', async () => {
    stub.onResolve = () => ({ status: 'none' });
    const none = await resolvePreview('https://blank.example/');
    expect(none.status).toBe('unavailable');
    expect(getCachedPreview('https://blank.example/')?.status).toBe('unavailable');

    stub.onResolve = () => ({ status: 'dead' });
    const dead = await resolvePreview('https://dead.example/');
    expect(dead.status).toBe('unavailable');
    expect(getCachedPreview('https://dead.example/')?.status).toBe('unavailable');
  });

  it('caches a refusal, so old scrollback stops re-asking', async () => {
    stub.onResolve = () => ({ status: 'refused', reason: 'resolves only to internal addresses' });
    const url = 'http://10.6.6.6/blocked';
    expect((await resolvePreview(url)).status).toBe('unavailable');
    const cached = getCachedPreview(url);
    expect(cached?.status).toBe('unavailable');
    // Echoed as ASKED, which is how the client looks it up.
    expect(cached?.url).toBe(url);
  });

  it('never caches a backoff, and honours the origin’s own Retry-After', async () => {
    // ⚠⚠ THE transient split, now crossing a process boundary: "not now" cached as "not
    // ever" is the permanently-blank-preview bug in its newest costume.
    stub.onResolve = () => ({ status: 'backoff', retryAfterS: 120 });
    const url = 'https://busy.example/';
    const rec = await resolvePreview(url);
    expect(rec.status).toBe('unavailable');
    expect(getCachedPreview(url)).toBeNull();
    const ttl = new Date(rec.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120 * 1000);
  });

  it('treats a decoder answering garbage as a moment, not a verdict', async () => {
    stub.onResolve = () => ({ status: 'garbage' });
    const url = 'https://skew.example/';
    const rec = await resolvePreview(url);
    expect(rec.status).toBe('unavailable');
    expect(getCachedPreview(url)).toBeNull();
    // Short, so the client re-asks once the deploy settles.
    const ttl = new Date(rec.expiresAt).getTime() - Date.now();
    expect(ttl).toBeLessThan(60_000);
  });

  it('treats an unreachable decoder the same way', async () => {
    const saved = process.env.LURKER_PREVIEWS_URL;
    process.env.LURKER_PREVIEWS_URL = 'http://127.0.0.1:1';
    try {
      const url = 'https://fine.example/but-decoder-down';
      const rec = await resolvePreview(url);
      expect(rec.status).toBe('unavailable');
      expect(getCachedPreview(url)).toBeNull();
    } finally {
      process.env.LURKER_PREVIEWS_URL = saved;
    }
  });

  it('goes dark with no decoder, including for what it already cached', async () => {
    // ⚠ The flag is checked BEFORE the cache read, not after. An operator who turns the feature
    // off has a table full of whatever it resolved while it was on, and "off" has to mean the
    // instance isn't participating — not that it keeps serving cards from a cache until the
    // TTL lapses a week later. Turning it off is often the response to a problem.
    const url = 'http://10.5.5.5/while-off';
    putPreview(record({ url, title: 'Cached While Enabled' }));
    expect(getCachedPreview(url)?.title).toBe('Cached While Enabled');

    // Off IS "no decoder URL" now.
    const saved = process.env.LURKER_PREVIEWS_URL;
    delete process.env.LURKER_PREVIEWS_URL;
    try {
      const off = await resolvePreview(url);
      expect(off.status).toBe('unavailable');
      expect(off.title).toBeNull();
      // ⚠ And a SHORT expiry. Keeping a transient answer out of the server's cache does nothing
      // if the descriptor tells the client to hold it for an hour.
      const ttl = new Date(off.expiresAt).getTime() - Date.now();
      expect(ttl).toBeLessThan(60_000);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEWS_URL;
      else process.env.LURKER_PREVIEWS_URL = saved;
    }
    // The row is left alone — turning the feature back on doesn't cost a refetch.
    expect(getCachedPreview(url)?.title).toBe('Cached While Enabled');
  });

  it('refuses an absurdly long URL before it can be hashed, stored or asked about', async () => {
    const url = `https://long.example/?q=${'a'.repeat(4000)}`;
    expect((await resolvePreview(url)).status).toBe('unavailable');
    expect(getCachedPreview(url)).toBeNull();
    // ⚠ Before the SEAM too: the decoder re-checks, but a URL this long should cost this
    // process nothing at all.
    expect(stub.resolveAsks).toEqual([]);
  });
});

describe('one ask per document', () => {
  it('coalesces concurrent anchors of one page into a single decoder ask', async () => {
    // ⚠⚠ Regression guard, and the reason the old origin-test file existed. In-flight dedupe
    // was keyed on the REQUEST STRING while the cache is keyed on the URL with its fragment
    // stripped — so three anchors of one document, which is exactly how anchors arrive (one
    // message, one batch), coalesced with nothing and cost three fetches of the same page.
    // Only a request count at the upstream can see that; every caller gets a correct-looking
    // record either way.
    stub.onResolve = () => ({ status: 'ok', meta: { kind: 'page', title: 'Anchored' } });
    const base = 'https://anchored.example/doc';
    const asked = [base, `${base}#a`, `${base}#b`, `${base}#c`];
    const records = await Promise.all(asked.map((u) => resolvePreview(u)));

    expect(stub.resolveAsks.length).toBe(1);
    for (const r of records) expect(r.title).toBe('Anchored');
    // ...and each caller is answered with the exact string it sent, because that is what it
    // looks the preview up by.
    expect(records.map((r) => r.url)).toEqual(asked);
  });

  it('treats host case and a default port as the same document', async () => {
    // ⚠ Regression guard. The key was the raw request string with a regex fragment strip, so
    // case and default-port variants were four cache entries for one page — and a
    // one-character cache bypass: vary the case and every ask refetches.
    stub.onResolve = () => ({ status: 'ok', meta: { kind: 'page', title: 'Canonical' } });
    await resolvePreview('https://case.example/canon');
    expect(stub.resolveAsks.length).toBe(1);

    const variant = await resolvePreview('https://CASE.EXAMPLE/canon');
    expect(variant.title).toBe('Canonical');
    expect(variant.url).toBe('https://CASE.EXAMPLE/canon');
    // Still one: the case variant read the row the first ask wrote.
    expect(stub.resolveAsks.length).toBe(1);
  });

  it('serves a later anchor from the cache, echoing the URL as asked', async () => {
    stub.onResolve = () => ({ status: 'ok', meta: { kind: 'page', title: 'Cached' } });
    const base = 'https://cached.example/doc';
    const first = await resolvePreview(`${base}#one`);
    expect(first.url).toBe(`${base}#one`);
    expect(stub.resolveAsks.length).toBe(1);

    const second = await resolvePreview(`${base}#two`);
    expect(second.title).toBe('Cached');
    expect(second.url).toBe(`${base}#two`);
    // Still one: the second ask never crossed the seam.
    expect(stub.resolveAsks.length).toBe(1);
  });

  it('does not leave a resolved URL pinned in the in-flight map', async () => {
    // ⚠ Regression guard. The give-up path used to return BEFORE entering the try, so the
    // `finally` never ran and a resolved promise stayed in the in-flight map for the life of
    // the process — every later ask replayed it and never consulted the DB cache again.
    stub.onResolve = () => ({ status: 'dead' });
    const url = 'https://twice.example/';
    await resolvePreview(url);
    const again = await resolvePreview(url);
    expect(again.status).toBe('unavailable');
    expect(again.expiresAt).toBe(getCachedPreview(url)?.expiresAt);
  });

  it('answers a burst for one URL with one ask and one row', async () => {
    stub.onResolve = () => ({ status: 'ok', meta: { kind: 'page', title: 'Hot' } });
    const url = 'https://hot.example/';
    const all = await Promise.all(Array.from({ length: 12 }, () => resolvePreview(url)));
    for (const r of all) expect(r.url).toBe(url);
    expect(stub.resolveAsks.length).toBe(1);
    expect(getCachedPreview(url)?.title).toBe('Hot');
  });
});
