// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { setupTestDb } from '../test-utils/testApp.js';
import type { PreviewRecord } from '../db/linkPreviews.js';

const ctx = setupTestDb('link-preview-service');

let resolvePreview: typeof import('./linkPreview.js').resolvePreview;
let toDescriptor: typeof import('./linkPreview.js').toDescriptor;
let dimensionsFromHead: typeof import('./linkPreview.js').dimensionsFromHead;
let getCachedPreview: typeof import('../db/linkPreviews.js').getCachedPreview;
let putPreview: typeof import('../db/linkPreviews.js').putPreview;
let OK_TTL_MS: number;

const SAVED_FLAG = process.env.LURKER_LINK_PREVIEWS;

beforeAll(async () => {
  process.env.LURKER_LINK_PREVIEWS = 'on';
  ({ getCachedPreview, putPreview, OK_TTL_MS } = await import('../db/linkPreviews.js'));
  ({ resolvePreview, toDescriptor, dimensionsFromHead } = await import('./linkPreview.js'));
});

afterAll(() => {
  if (SAVED_FLAG === undefined) delete process.env.LURKER_LINK_PREVIEWS;
  else process.env.LURKER_LINK_PREVIEWS = SAVED_FLAG;
  ctx.cleanup();
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
    expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    ...over,
  };
}

describe('pageRecord: what is enough to be worth a card', () => {
  it('keeps a video embed that has neither a title nor an image', async () => {
    // ⚠⚠ Regression guard. `!title && !imageUrl` are PAGE concepts, and the give-up rule
    // consulted only those: a YouTube link whose provider oEmbed call failed — rate-limited,
    // endpoint retired, "none of which should mean no preview at all" — falls through to a
    // scrape that finds nothing, because YouTube's og: tags sit past the 512 KB cap. So the
    // embed URL it was already holding was thrown away and the loss cached for an hour.
    //
    // Tested here rather than through the live-origin harness because `videoEmbedFor` only
    // matches real provider hosts, so this branch is unreachable from a loopback server — and a
    // test that stops at `toDescriptor` never runs this rule at all. (It didn't. It passed with
    // the fix reverted, which is what put this test here.)
    const { pageRecord } = await import('./linkPreview.js');
    const out = pageRecord(new URL('https://www.youtube.com/watch?v=abc123'), null, {});
    expect(out.status).toBe('ok');
    expect(out.kind).toBe('video-embed');
    expect(out.embedUrl).toContain('youtube-nocookie.com');
    expect(out.title).toBeNull();
  });

  it('gives a contentless embed the FAILURE ttl, not the seven-day one', async () => {
    // ⚠ Regression guard. Keeping the embed is right — the play affordance is real content —
    // but a record kept only by that clause has no title, no description and no thumbnail: its
    // whole visible substance is the hostname. It is a DEGRADED answer, produced because the
    // provider call that would have filled it in just failed, so caching it for seven days
    // banks one rate-limited minute for a week. An hour is what the situation calls for.
    const { pageRecord } = await import('./linkPreview.js');
    const { OK_TTL_MS, FAIL_TTL_MS } = await import('../db/linkPreviews.js');

    const thin = pageRecord(new URL('https://www.youtube.com/watch?v=abc123'), null, {});
    const thinTtl = new Date(thin.expiresAt).getTime() - Date.now();
    expect(thinTtl).toBeLessThanOrEqual(FAIL_TTL_MS);

    // ...while an embed that DID get its metadata keeps the success TTL.
    const full = pageRecord(new URL('https://www.youtube.com/watch?v=abc123'), null, {
      title: 'A Real Video',
    });
    const fullTtl = new Date(full.expiresAt).getTime() - Date.now();
    expect(fullTtl).toBeGreaterThan(FAIL_TTL_MS);
    expect(fullTtl).toBeLessThanOrEqual(OK_TTL_MS);
  });

  it('still gives up on an ordinary page with nothing to show', async () => {
    // The rule has to keep doing its job: a card with no title, no image and no embed is a grey
    // rectangle, and the plain link the user typed is better.
    const { pageRecord } = await import('./linkPreview.js');
    expect(pageRecord(new URL('https://example.com/blank'), null, {}).status).toBe('unavailable');
  });
});

describe('toDescriptor', () => {
  it('proxies a page thumbnail and never leaks the origin URL', () => {
    const d = toDescriptor(record({ imageUrl: 'https://cdn.example.com/t.png', imageWidth: 800 }));
    expect(d.thumb).toMatch(/^\/api\/link-preview\/media\//);
    expect(d.src).toBeUndefined();
    expect(d.thumbWidth).toBe(800);
    expect(JSON.stringify(d)).not.toContain('cdn.example.com');
  });

  it('puts direct media in src, because the bytes ARE the content', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      const d = toDescriptor(record({ kind, imageUrl: 'https://cdn.example.com/a.bin' }));
      expect(d.src).toMatch(/^\/api\/link-preview\/media\//);
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

describe('dimensionsFromHead: the numbers a client reserves a box from', () => {
  // ⚠⚠ These are a LAYOUT PROMISE, not a statistic. The client reserves an image's box from this
  // ratio before any bytes arrive (MessageAttachment's `reserveStyle`, lurker#705), so a pair that
  // disagrees with what the browser decodes is a permanently wrong-shaped box rather than a jump.
  async function jpeg(w: number, h: number, orientation?: number) {
    const img = sharp({ create: { width: w, height: h, channels: 3, background: '#888' } });
    return await (orientation ? img.withMetadata({ orientation }) : img).jpeg().toBuffer();
  }

  it('reports what the BROWSER will decode, not what the file stores', async () => {
    // A phone photo shot in portrait: stored landscape, with orientation 6 telling the decoder to
    // rotate it. Browsers honour that (`image-orientation: from-image` is the default) and sharp's
    // `metadata()` does not — so reading `meta.width`/`meta.height` hands the client a transposed
    // box for the most ordinary photo on the platform. `imagePipeline.ts` already calls `.rotate()`
    // for the same reason; this is that rule on the measuring path.
    const rotated = await jpeg(400, 300, 6);

    // ⚠ The probe is checked BEFORE it is trusted: sharp silently drops the tag on some write
    // paths (`withExifMerge` did, in the console probe that first tried this), and a fixture with
    // orientation 1 makes the assertion below pass against the very bug it guards.
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    expect(await dimensionsFromHead(rotated)).toEqual({ width: 300, height: 400 });

    // And the ordinary case is untouched — no tag, no transpose.
    expect(await dimensionsFromHead(await jpeg(400, 300))).toEqual({ width: 400, height: 300 });
  });

  it('falls back to the header reader for a container sharp refuses', async () => {
    // The 64 KB truncation case (#697): webp/gif/tiff declare a total length and their loaders
    // reject a short file before decoding it. A real photo is far past the cap, so this is the
    // ordinary path for a pasted WebP — not an edge case.
    const webp = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#111' },
    })
      .webp()
      .toBuffer();
    const truncated = webp.subarray(0, 40);

    // ⚠ Probe first: if sharp ever starts reading this buffer, the fallback stops being exercised
    // and the assertion below would pass through the branch it is not written to cover.
    // ⚠ Asserts THAT it rejects, never with what wording — libvips' message is its own business and
    // varies by version and platform. It reads as an odd way to write `.rejects.toThrow()` because
    // it is: the bare form trips `vitest(require-to-throw-message)`, and satisfying that lint rule
    // is what pinned /corrupt header/ here in the first place (Copilot, #737).
    await expect(sharp(truncated).metadata()).rejects.toBeInstanceOf(Error);

    expect(await dimensionsFromHead(truncated)).toEqual({ width: 120, height: 80 });
    expect(await dimensionsFromHead(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('resolvePreview', () => {
  it('goes dark when the feature is off, including for what it already cached', async () => {
    // ⚠ The flag is checked BEFORE the cache read, not after. An operator who turns the feature
    // off has a table full of whatever it resolved while it was on, and "off" has to mean the
    // instance isn't participating — not that it keeps serving cards from a cache until the
    // TTL lapses a week later. Turning it off is often the response to a problem.
    const url = 'http://10.5.5.5/while-off';
    putPreview({
      url,
      status: 'ok',
      kind: 'page',
      title: 'Cached While Enabled',
      description: null,
      siteName: null,
      author: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      embedUrl: null,
      mime: null,
      expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    });
    expect(getCachedPreview(url)?.title).toBe('Cached While Enabled');

    const saved = process.env.LURKER_LINK_PREVIEWS;
    delete process.env.LURKER_LINK_PREVIEWS;
    try {
      const off = await resolvePreview(url);
      expect(off.status).toBe('unavailable');
      expect(off.title).toBeNull();
      // ⚠ And a SHORT expiry. Keeping a transient answer out of the server's cache does nothing
      // if the descriptor tells the client to hold it for an hour — `expiresAt` is the only
      // thing a client has for deciding when to re-ask, so stamping the failure TTL on an
      // instance-state answer re-created the permanent blankness at the other end.
      const ttl = new Date(off.expiresAt).getTime() - Date.now();
      expect(ttl).toBeLessThan(60_000);
      expect(ttl).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.LURKER_LINK_PREVIEWS;
      else process.env.LURKER_LINK_PREVIEWS = saved;
    }
    // The row is left alone — turning the feature back on doesn't cost a refetch.
    expect(getCachedPreview(url)?.title).toBe('Cached While Enabled');
  });

  it('refuses an absurdly long URL before it can be hashed or stored', async () => {
    // Nothing upstream caps this: normalizeUrl is happy with a megabyte of query string, and
    // the value would end up in a row, a response, and a base64 proxy token a third longer.
    //
    // ⚠ A blocked address, not a real hostname, so removing the cap makes this test go red
    // rather than send a 4 KB request to a stranger: a blocked URL is also `unavailable`, but
    // it is a VERDICT and gets cached, and the cache assertion is what tells the two apart.
    const url = `http://10.3.3.3/?q=${'a'.repeat(4000)}`;
    expect((await resolvePreview(url)).status).toBe('unavailable');
    expect(getCachedPreview(url)).toBeNull();
  });

  it('caches a refusal, so old scrollback stops re-asking', async () => {
    // A blocked address makes this offline and deterministic. `unavailable` is a real answer:
    // without caching it, every scroll past a dead link in history reopens a socket.
    const url = 'http://10.6.6.6/blocked';
    expect((await resolvePreview(url)).status).toBe('unavailable');
    const cached = getCachedPreview(url);
    expect(cached?.status).toBe('unavailable');
    // Echoed as ASKED, which is how the client looks it up.
    expect(cached?.url).toBe(url);
  });

  it('collapses fragments to one cache entry but echoes the URL as asked', async () => {
    // ⚠ Two identities, deliberately. `#intro` and `#appendix` of one document are the same
    // fetch (the fragment never reaches the origin), so they share a row — while each caller
    // gets back the exact string it sent, because that is what it will look the answer up by.
    const base = 'http://10.7.7.7/doc';
    await resolvePreview(`${base}#intro`);
    const second = await resolvePreview(`${base}#appendix`);
    // ⚠ The row's own `url` column holds `#intro` — whoever resolved it first. Handing that
    // back verbatim is the C-class identity bug reached through the cache instead of through a
    // redirect: it renders for the first reader and silently for nobody else.
    expect(second.url).toBe(`${base}#appendix`);
    expect(getCachedPreview(`${base}#intro`)?.url).toBe(`${base}#intro`);
  });

  it('coalesces concurrent anchors of one document into a single resolve', async () => {
    // Anchors arrive together — a message linking three sections of one page is one batch —
    // so in-flight dedupe keyed on the request string coalesces nothing and pays for the same
    // page N times, undoing the collapse the cache key exists to provide.
    const base = 'http://10.7.8.8/anchored';
    const asked = [`${base}#a`, `${base}#b`, `${base}#c`, base];
    const all = await Promise.all(asked.map((u) => resolvePreview(u)));
    // Each caller still gets back the exact string it sent.
    expect(all.map((r) => r.url)).toEqual(asked);
  });

  it('does not leave a resolved URL pinned in the in-flight map', async () => {
    // ⚠ Regression guard. The give-up path used to return BEFORE entering the try, so the
    // `finally` never ran and a resolved `unavailable` promise stayed in the in-flight map for
    // the life of the process — every later ask replayed it and never consulted the DB again,
    // which is permanent blankness rather than the momentary answer it was meant to be.
    const url = 'http://10.8.8.8/twice';
    await resolvePreview(url);
    // If the entry were still pinned this would replay the old promise. The observable
    // difference is the cache: a second real call reads the row that the first one wrote.
    const again = await resolvePreview(url);
    expect(again.status).toBe('unavailable');
    expect(again.expiresAt).toBe(getCachedPreview(url)?.expiresAt);
  });

  it('answers a burst for one URL with one row', async () => {
    const url = 'http://10.9.1.1/hot';
    const all = await Promise.all(Array.from({ length: 12 }, () => resolvePreview(url)));
    for (const r of all) expect(r.url).toBe(url);
    expect(getCachedPreview(url)?.status).toBe('unavailable');
  });
});
