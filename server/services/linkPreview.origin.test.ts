// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver against a real origin, over real sockets.
//
// Its own file for the same reason `linkFetch.redirects.test.ts` is: the real address policy
// blocks loopback, correctly, so no test can watch a resolve COMPLETE against a server it just
// started. The policy is swapped for a test one — allow 127.0.0.1, refuse everything else — and
// everything else runs for real.
//
// ⚠ What's mocked is the POLICY, never the mechanism. The fetch, the redirect loop, the pinned
// lookup, the head scan, the charset decode, the scrape and the cache are all shipping code. The
// policy itself is tested against the real implementation in ../utils/ipGuard.test.ts.
//
// This is the only place several claims are provable at all, because each needs a REQUEST COUNT
// at a live origin rather than an error: that a batch of anchors costs one fetch, that a cache
// hit costs none, and that a declared charset is honoured.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import { setupTestDb } from '../test-utils/testApp.js';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const ctx = setupTestDb('link-preview-origin');
process.env.LURKER_LINK_PREVIEWS = 'on';

const { resolvePreview, toDescriptor } = await import('./linkPreview.js');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let hits: string[] = [];
let server: http.Server;
/** Reached through `localhost`, so the pinned lookup's success path is the one under test. */
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url || '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  ctx.cleanup();
});

function reset(h: Handler) {
  hits = [];
  handler = h;
}

/** Serve one HTML document, whatever is asked for. */
function serveHtml(html: string, contentType = 'text/html; charset=utf-8'): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': contentType });
    res.end(html);
  };
}

describe('resolving a page at a live origin', () => {
  it('scrapes a card and proxies the image, in one request', async () => {
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Tom &amp; Jerry">
        <meta property="og:description" content="A cat and a mouse.">
        <meta property="og:site_name" content="Example Cartoons">
        <meta property="og:image" content="/art/still.png">
      </head><body><p>ignored</p></body></html>`),
    );

    const record = await resolvePreview(`${base}/article`);
    expect(record.status).toBe('ok');
    expect(record.kind).toBe('page');
    // Decoded exactly once. A second pass is what turns `&amp;amp;` into `&`, and both
    // producers decode at their own boundary now.
    expect(record.title).toBe('Tom & Jerry');
    expect(record.description).toBe('A cat and a mouse.');
    expect(record.siteName).toBe('Example Cartoons');
    // Relative og:image resolved against the page we landed on.
    expect(record.imageUrl).toBe(`${base}/art/still.png`);
    // The head is all we pay for: no second GET for the body, and the image is NOT fetched
    // during resolve — the client asks the proxy for it, and only if it renders the card.
    expect(hits).toEqual(['/article']);

    const d = toDescriptor(record);
    // The client is handed a path under OUR origin. (`url` still echoes what was asked for —
    // that's the lookup key, not a fetch target — and the token's payload is base64 of the
    // image URL by construction. The property is that no client dials the origin, not that the
    // address is a secret.)
    expect(d.thumb).toMatch(/^\/api\/link-preview\/media\//);
    expect(d.thumb).not.toContain('localhost');
  });

  it('decodes an image URL exactly once', async () => {
    // ⚠ Regression guard. `scrapeMeta` and `readOEmbed` each decode entities at their own
    // boundary now, so the resolver decoding `imageUrl` again is one pass too many — and a
    // second pass is invisible until a document contains a LITERAL entity: `&amp;amp;` is the
    // correct markup for the text `&amp;`, and decoding twice turns it into `&`, which is a
    // different URL and a 404 where a thumbnail should be.
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Twice">
        <meta property="og:image" content="/art.png?tag=a&amp;amp;b&amp;v=1">
      </head></html>`),
    );

    const record = await resolvePreview(`${base}/entities`);
    expect(record.imageUrl).toBe(`${base}/art.png?tag=a&amp;b&v=1`);
  });

  it('honours a charset the origin declared and the document does not', async () => {
    // ⚠ Regression guard for the `decodeBody` handoff. The old call passed the Content-Type
    // header, but what reached it was already stripped to a bare `text/html` — so the charset
    // branch could never match and a windows-1251 page with no in-document `<meta charset>`
    // rendered as replacement characters. Only a live origin can prove this: it needs the
    // header and the body to disagree with UTF-8 together.
    const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/HTML; charset="Windows-1251"' });
      res.end(
        Buffer.concat([
          Buffer.from('<html><head><meta property="og:title" content="'),
          cyrillic,
          Buffer.from('"></head><body><p>x</p></body></html>'),
        ]),
      );
    });

    const record = await resolvePreview(`${base}/cyrillic`);
    expect(record.title).toBe('Привет');
    expect(record.title).not.toContain('�');
  });

  it('uses the hostname when a page offers only a twitter handle', async () => {
    // `twitter:site` is an @handle naming an account, not a site. Absent beats wrong: the card
    // gets the hostname, which is always accurate.
    reset(
      serveHtml(`<html><head>
        <meta name="twitter:site" content="@examplenews">
        <meta property="og:title" content="Headline">
      </head><body><p>x</p></body></html>`),
    );

    const record = await resolvePreview(`${base}/handle-only`);
    expect(record.title).toBe('Headline');
    expect(record.siteName).toBe('localhost');
  });

  it('reads an image’s dimensions without pulling the whole file', async () => {
    const png = await sharp({
      create: { width: 240, height: 100, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });

    const record = await resolvePreview(`${base}/photo.png`);
    expect(record.kind).toBe('image');
    expect(record.mime).toBe('image/png');
    // The point of reading these at all: the client reserves the box before the bytes arrive,
    // so a bottom-anchored message list doesn't grow a second time when the image decodes.
    expect(record.imageWidth).toBe(240);
    expect(record.imageHeight).toBe(100);
    // Direct media puts the bytes in `src`, not in a card's `thumb`.
    const d = toDescriptor(record);
    expect(d.src).toMatch(/^\/api\/link-preview\/media\//);
    expect(d.thumb).toBeUndefined();
  });

  it('still builds a card when the page advertises a broken oEmbed endpoint', async () => {
    // ⚠ Regression guard. The oEmbed href comes out of a stranger's markup, and `new URL('http://[')`
    // throws while BUILDING the argument to the guard that was supposed to judge it — so with
    // the resolve outside the try, a malformed href abandoned the whole resolution and the page
    // got no preview at all. oEmbed is the OPTIONAL path: failing it must fall back to the Open
    // Graph tags already in hand, not discard them.
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Survived">
        <link rel="alternate" type="application/json+oembed" href="http://[">
      </head></html>`),
    );

    const record = await resolvePreview(`${base}/broken-oembed`);
    expect(record.status).toBe('ok');
    expect(record.title).toBe('Survived');
  });

  it('clamps a long title without splitting a character', async () => {
    // ⚠ Regression guard. The clamp used `slice`, which counts UTF-16 code units, so a title
    // of emoji cut at 140 ended in a lone high surrogate. That does not survive the SQLite
    // round trip — so the requester who resolved the URL and everyone served from the cache
    // afterwards got measurably DIFFERENT strings for the same page, and a strict decoder
    // (Swift's JSONDecoder, on the iOS client) turns the escape into U+FFFD.
    reset(
      serveHtml(
        `<html><head><meta property="og:title" content="${'👍'.repeat(200)}"></head></html>`,
      ),
    );

    const fresh = await resolvePreview(`${base}/emoji`);
    const title = fresh.title as string;
    expect(title.length).toBeLessThan(400);
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lonely.test(title)).toBe(false);
    // The read-back is what the second and every later viewer is served.
    const cached = await resolvePreview(`${base}/emoji`);
    expect(cached.title).toBe(title);
  });

  it('refuses a content type it has no rendering for', async () => {
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    });
    expect((await resolvePreview(`${base}/paper.pdf`)).status).toBe('unavailable');
  });

  it('refuses SVG, which is a script host wearing a picture’s clothes', async () => {
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    });
    expect((await resolvePreview(`${base}/logo.svg`)).status).toBe('unavailable');
  });
});

describe('one fetch per document', () => {
  it('coalesces concurrent anchors of one page into a single request', async () => {
    // ⚠⚠ Regression guard, and the reason this file exists. In-flight dedupe was keyed on the
    // REQUEST STRING while the cache is keyed on the URL with its fragment stripped — so three
    // anchors of one document, which is exactly how anchors arrive (one message, one batch),
    // coalesced with nothing and cost three fetches of the same page. Only a request count at a
    // live origin can see that; every caller gets a correct-looking record either way.
    reset(serveHtml('<html><head><meta property="og:title" content="Anchored"></head></html>'));

    const asked = [`${base}/doc`, `${base}/doc#a`, `${base}/doc#b`, `${base}/doc#c`];
    const records = await Promise.all(asked.map((u) => resolvePreview(u)));

    expect(hits).toEqual(['/doc']);
    for (const r of records) expect(r.title).toBe('Anchored');
    // ...and each caller is answered with the exact string it sent, because that is what it
    // looks the preview up by.
    expect(records.map((r) => r.url)).toEqual(asked);
  });

  it('treats host case and a default port as the same document', async () => {
    // ⚠ Regression guard. The key was the raw request string with a regex fragment strip, so
    // `//LOCALHOST/x` and `//localhost/x` — and `//h:80/x` and `//h/x`, and a trailing slash —
    // were four cache entries for one page. normalizeUrl already collapses all of them, and it
    // is the function the fetcher uses, so keying on anything else was two identities for one
    // thing. It is also a one-character cache bypass: vary the case and every ask refetches.
    reset(serveHtml('<html><head><meta property="og:title" content="Canonical"></head></html>'));
    const port = (server.address() as AddressInfo).port;

    await resolvePreview(`http://localhost:${port}/canon`);
    expect(hits).toEqual(['/canon']);

    const variant = await resolvePreview(`http://LOCALHOST:${port}/canon`);
    expect(variant.title).toBe('Canonical');
    expect(variant.url).toBe(`http://LOCALHOST:${port}/canon`);
    // Still one: the case variant read the row the first ask wrote.
    expect(hits).toEqual(['/canon']);
  });

  it('keeps the scraped image when an oEmbed thumbnail is unusable', async () => {
    // ⚠ Regression guard. `oembed?.thumbnailUrl || meta.imageUrl` picked first and vetted
    // second, so a thumbnail_url we refuse — here a private address the SSRF guard blocks —
    // took the slot and then evaporated, discarding a perfectly good og:image with it. On a
    // page with no title that became a cached `unavailable`: no card for an hour because the
    // OPTIONAL source was bad.
    reset((req, res) => {
      if (req.url === '/oembed.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.0',
            type: 'rich',
            thumbnail_url: 'http://10.0.0.9/private.png',
            thumbnail_width: 480,
            thumbnail_height: 360,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head>
        <meta property="og:title" content="Fallback Kept">
        <meta property="og:image" content="/real.png">
        <link rel="alternate" type="application/json+oembed" href="/oembed.json">
      </head></html>`);
    });

    const record = await resolvePreview(`${base}/oembed-bad-thumb`);
    expect(record.imageUrl).toBe(`${base}/real.png`);
    // ...and the oEmbed dimensions do NOT come along: they describe the thumbnail that lost,
    // so pairing them with this image reserves a 4:3 box for a picture of another shape.
    expect(record.imageWidth).toBeNull();
    expect(record.imageHeight).toBeNull();
  });

  it('serves a later anchor from the cache, echoing the URL as asked', async () => {
    // Sequential, so the cache read is what answers rather than the in-flight map. The row's
    // own `url` column holds whichever anchor resolved first — handing that back verbatim is
    // the same client-side miss, reached through the cache instead of through a redirect.
    reset(serveHtml('<html><head><meta property="og:title" content="Cached"></head></html>'));

    const first = await resolvePreview(`${base}/cached-doc#one`);
    expect(hits).toEqual(['/cached-doc']);

    const second = await resolvePreview(`${base}/cached-doc#two`);
    expect(second.title).toBe('Cached');
    expect(second.url).toBe(`${base}/cached-doc#two`);
    expect(first.url).toBe(`${base}/cached-doc#one`);
    // Still one: the second ask never reached the origin.
    expect(hits).toEqual(['/cached-doc']);
  });
});
