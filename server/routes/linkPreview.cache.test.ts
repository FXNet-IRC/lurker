// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The byte cache through the ROUTE, against a real origin that counts how often
// it is asked. Its own file rather than cases bolted onto linkPreview.media.test:
// the cache is configured from the environment and resolved once per process, so
// a suite that shares a module registry with the uncached tests cannot have both.
//
// ⚠⚠ The assertion that matters everywhere here is the ORIGIN HIT COUNT. "The
// second request returned the right bytes" is true with the cache ripped out —
// it would just fetch them again. Counting the fetches is the only thing that
// distinguishes a working cache from a working proxy, and it is the property the
// whole feature exists for.
//
// ⚠ What's mocked is the POLICY, never the mechanism: the address guard is
// inverted so a loopback origin is reachable at all. Express, the token, the
// throttles, the pool, safeRequest, the pinned lookup, the pipe, the filesystem
// and the SQLite index are all shipping code.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const ctx = setupTestDb('routes-link-preview-cache');
process.env.LURKER_LINK_PREVIEWS = 'on';
process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'preview-cache');

let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let countCached: typeof import('../db/previewCache.js').countCached;
let whenStoresSettle: typeof import('../services/previewCache/index.js').whenStoresSettle;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;
/** How many times the ORIGIN was actually asked. The whole point, in one number. */
let originHits = 0;
/** Connections to the raw (unframed) origin, which is its own server. */
let rawHits = 0;

const tokenFor = (p: string): string => mintProxyToken(`${base}${p}`);

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  ({ countCached } = await import('../db/previewCache.js'));
  ({ whenStoresSettle } = await import('../services/previewCache/index.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-cache');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);

  origin = http.createServer((req, res) => {
    originHits++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(origin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  ctx.cleanup();
});

beforeEach(async () => {
  // ⚠⚠ Drains BEFORE clearing. The route stores fire-and-forget so a slow bucket
  // cannot hold a response open, which means a write from the previous test can
  // still be in flight while this one wipes the table — and it then lands in the
  // clean state and reads as "this test cached something". That is precisely how
  // the absence assertions below (`toBe(0)`) went green against the wrong cause.
  await whenStoresSettle();
  originHits = 0;
  rawHits = 0;
  const { default: db } = await import('../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
  fs.rmSync(process.env.LURKER_PREVIEW_CACHE_DIR!, { recursive: true, force: true });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function servePng(body = PNG): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  };
}

describe('the byte cache, end to end', () => {
  it('fetches an image once and serves the second read from the cache', async () => {
    servePng();
    const token = tokenFor('/cached.png');

    const first = await agent.get(`/api/link-preview/media/${token}`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).equals(PNG)).toBe(true);
    expect(originHits).toBe(1);
    await whenStoresSettle();

    const second = await agent.get(`/api/link-preview/media/${token}`);
    expect(second.status).toBe(200);
    // ⚠ THE assertion. Same bytes proves nothing on its own — the uncached path
    // returns those too. One origin hit for two reads is the feature.
    expect(originHits).toBe(1);
    expect(Buffer.from(second.body).equals(PNG)).toBe(true);
  });

  it('serves the cached copy with the same hardening headers as a live fetch', async () => {
    servePng();
    const token = tokenFor('/headers.png');
    const live = await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    const cached = await agent.get(`/api/link-preview/media/${token}`);
    expect(originHits).toBe(1);

    // ⚠⚠ The cache added a SECOND way to send a response body, and these headers are
    // what stop a third party's bytes being interpreted as something other than the
    // type we allowlisted. A cached image served without `nosniff` is the same
    // vulnerability as an uncached one, reached by omission — which is exactly the
    // kind of gap a "does it return the bytes" test sails past.
    for (const h of [
      'content-type',
      'x-content-type-options',
      'content-security-policy',
      'content-disposition',
      'cross-origin-resource-policy',
      'cache-control',
    ]) {
      expect(`${h}: ${cached.headers[h]}`).toBe(`${h}: ${live.headers[h]}`);
    }
  });

  it('does not cache a video, however many times it is asked for', async () => {
    // ⚠ Deliberate: 64 MB against images' 8 MB, and range-read, so a cached copy
    // would have to answer partial reads. Buffering one per miss to store it trades
    // the bandwidth this feature saves for memory it cannot bound.
    const MP4 = Buffer.alloc(2048, 7);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) });
      res.end(MP4);
    };
    const token = tokenFor('/clip.mp4');
    await agent.get(`/api/link-preview/media/${token}`);
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(2);
    expect(countCached()).toBe(0);
  });

  it('passes a RANGE request through and stores nothing from it', async () => {
    // Serving a whole object to a request that asked for a window is a correctness
    // bug, not a slow path — so a ranged read is neither answered from the cache nor
    // allowed to populate it with a partial body.
    handler = (req, res) => {
      if (req.headers.range) {
        res.writeHead(206, {
          'content-type': 'image/png',
          'content-range': `bytes 0-9/${PNG.length}`,
          'accept-ranges': 'bytes',
        });
        res.end(PNG.subarray(0, 10));
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    };
    const token = tokenFor('/ranged.png');
    const ranged = await agent.get(`/api/link-preview/media/${token}`).set('Range', 'bytes=0-9');
    expect(ranged.status).toBe(206);
    await whenStoresSettle();
    expect(countCached()).toBe(0);

    // ...and the partial read did not poison the full one.
    const full = await agent.get(`/api/link-preview/media/${token}`);
    expect(full.status).toBe(200);
    expect(Buffer.from(full.body).equals(PNG)).toBe(true);
  });

  it('stores nothing when the origin dies mid-body, and re-fetches next time', async () => {
    // ⚠⚠ The corruption this design must not have. A body cut short is still a
    // stream of real bytes; cached, it becomes a permanently broken image served to
    // everyone afterwards, and the browser holds it for a day. Only `end` on the
    // upstream means "complete object", which is why the store hangs off that rather
    // than off the response finishing.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.write(PNG.subarray(0, 10));
      // ⚠ Killed on a LATER tick, deliberately. Destroying the socket in the same
      // breath as the headers made `safeRequest` itself reject, so the route took
      // its catch branch and never began streaming — the test passed while proving
      // only "a dead origin caches nothing", which is not the guard it names. The
      // delay is what gets a partial body through the pipe and into the collector,
      // which is the state the truncation check actually exists for.
      setTimeout(() => res.destroy(), 60);
    };
    const token = tokenFor('/truncated.png');
    await agent.get(`/api/link-preview/media/${token}`).catch(() => undefined);
    await whenStoresSettle();
    expect(countCached()).toBe(0);

    servePng();
    const retry = await agent.get(`/api/link-preview/media/${token}`);
    expect(retry.status).toBe(200);
    expect(Buffer.from(retry.body).equals(PNG)).toBe(true);
  });

  it('refuses to cache a body framed only by the connection closing', async () => {
    // ⚠⚠ The hazard `ended` cannot see. With no Content-Length and no chunked
    // encoding, the close of the connection IS the terminator — so node emits `end`
    // with `complete: true` for a body that was cut short, and a truncated image
    // looks exactly like a finished one. This route makes that ordinary rather than
    // exotic: `linkFetch` sets `keepAlive: false`, so every request carries
    // `Connection: close`, which is precisely when RFC 7230 lets an origin omit
    // framing.
    //
    // A raw socket rather than `http.Server`, because node's server always frames a
    // response for you — Content-Length or chunked — so the state under test cannot
    // be produced through it at all.
    const raw = net.createServer((sock) => {
      rawHits++;
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n');
      sock.write(PNG.subarray(0, 12));
      setTimeout(() => sock.destroy(), 60);
    });
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    const rawPort = (raw.address() as AddressInfo).port;
    try {
      const token = mintProxyToken(`http://localhost:${rawPort}/unframed.png`);
      await agent.get(`/api/link-preview/media/${token}`).catch(() => undefined);
      await whenStoresSettle();
      // ⚠ The origin WAS reached — otherwise this would pass for the boring reason
      // that nothing happened, which is the failure mode absence tests have.
      expect(rawHits).toBe(1);
      // The half-image must not have been kept. Cached, it would be served to every
      // viewer thereafter under `immutable`, and the repair path only fires for a
      // file that is MISSING — a broken-but-present entry has none.
      expect(countCached()).toBe(0);
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  it('still caches a CHUNKED response, which framing does prove', async () => {
    // ⚠ The other half, and the reason the guard is not simply "require
    // Content-Length". A chunked body cut short does NOT emit `end` — node raises
    // `aborted` and leaves `complete` false — so `ended` already proves completeness
    // there. Refusing chunked outright would have declined to cache a great many
    // perfectly ordinary origins to fix a hazard chunked does not have.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' }); // no content-length → chunked
      res.end(PNG);
    };
    const token = tokenFor('/chunked.png');
    const first = await agent.get(`/api/link-preview/media/${token}`);
    expect(first.status).toBe(200);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    const second = await agent.get(`/api/link-preview/media/${token}`);
    expect(originHits).toBe(1);
    expect(Buffer.from(second.body).equals(PNG)).toBe(true);
  });

  it('leaves no temp file behind when the origin sends an empty body', async () => {
    // ⚠⚠ A 200 with `Content-Length: 0` is framed, complete and cacheable-looking —
    // it just has nothing in it. The commit path declined it without closing or
    // aborting the writer, so the stream's fd stayed open and its `.tmp` stayed on
    // disk: one leaked descriptor and one orphaned file PER REQUEST, invisible to
    // eviction because the index never learned about them, and nothing sweeps the
    // shard directories. Repeatable by any origin serving an empty image.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '0' });
      res.end();
    };
    const token = tokenFor('/empty.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();

    expect(countCached()).toBe(0);
    // ⚠ The assertion that bites. countCached() is 0 whether or not the temp file
    // was cleaned up — the leak is only visible on disk.
    const dir = process.env.LURKER_PREVIEW_CACHE_DIR!;
    const stray: string[] = [];
    if (fs.existsSync(dir)) {
      for (const shard of fs.readdirSync(dir)) {
        for (const f of fs.readdirSync(path.join(dir, shard))) stray.push(f);
      }
    }
    expect(stray).toEqual([]);
  });

  it('re-fetches, rather than failing, when the cached file is deleted underneath it', async () => {
    servePng();
    const token = tokenFor('/vanishing.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    fs.rmSync(process.env.LURKER_PREVIEW_CACHE_DIR!, { recursive: true, force: true });

    const after = await agent.get(`/api/link-preview/media/${token}`);
    expect(after.status).toBe(200);
    expect(Buffer.from(after.body).equals(PNG)).toBe(true);
    expect(originHits).toBe(2);
  });

  it('refuses to cache a document served as an image, but still serves the reader', async () => {
    // ⚠⚠ The attack this closes. `cacheable` asks `kindForContentType`, which reads
    // the header the ORIGIN sent — so an origin under someone else's control answers
    // `Content-Type: image/png` with an HTML document and, before the signature
    // check, we kept those bytes and served them back under our own name with
    // `Content-Disposition: inline`. The URL is minted to the poster's own client,
    // so handing it to a victim is not a hurdle.
    const HTML = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>', 'utf8');
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(HTML.length) });
      res.end(HTML);
    };
    const token = tokenFor('/not-really.png');
    const res = await agent.get(`/api/link-preview/media/${token}`);
    // ⚠ The reader is NOT failed. This is a cache gate, not a content filter — the
    // proxy has always passed these bytes through with `nosniff` and a CSP sandbox
    // on them, and changing that is a different decision from declining to KEEP
    // them. Failing here would be a behaviour change for every uncached instance.
    expect(res.status).toBe(200);
    await whenStoresSettle();
    expect(countCached()).toBe(0);

    // ...and nothing was left on disk either, since the writer was aborted rather
    // than merely un-recorded.
    const dir = process.env.LURKER_PREVIEW_CACHE_DIR!;
    const stray: string[] = [];
    if (fs.existsSync(dir)) {
      for (const shard of fs.readdirSync(dir)) {
        for (const f of fs.readdirSync(path.join(dir, shard))) stray.push(f);
      }
    }
    expect(stray).toEqual([]);
  });

  it('still caches a real image whose content type the origin got wrong', async () => {
    // ⚠ The gate asks "are these bytes an image at all", NOT "do they match the
    // declared subtype". Origins mislabel real images routinely, browsers decode by
    // magic bytes regardless, and refusing those would cost hit rate to fix nothing.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PNG.length) });
      res.end(PNG); // actually a PNG
    };
    const token = tokenFor('/mislabelled.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    const second = await agent.get(`/api/link-preview/media/${token}`);
    expect(originHits).toBe(1);
    expect(Buffer.from(second.body).equals(PNG)).toBe(true);
    // ⚠ Served back with what the ORIGIN said, not with the sniffed type: the
    // uncached path passes the origin's header through untouched, so correcting it
    // only when cached would make the first and second loads disagree.
    expect(second.headers['content-type']).toBe('image/jpeg');
  });

  it('assembles the signature from a header that arrives one byte at a time', async () => {
    // ⚠ The header is not guaranteed to be in the first chunk. A slow origin, a
    // proxy, or TCP itself can split it anywhere — and the accumulator that stitches
    // it back together is the kind of index arithmetic that is wrong by one and
    // still passes every single-chunk test. A PNG signature is 8 bytes, so dribbling
    // guarantees it spans several.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      let i = 0;
      const tick = (): void => {
        if (i >= PNG.length) {
          res.end();
          return;
        }
        res.write(PNG.subarray(i, i + 1));
        i++;
        setImmediate(tick);
      };
      tick();
    };
    const token = tokenFor('/dribbled.png');
    const first = await agent.get(`/api/link-preview/media/${token}`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).equals(PNG)).toBe(true);
    await whenStoresSettle();
    // ⚠ It must be CACHED — a gate that cannot reassemble a split header would
    // silently refuse every slow origin, which reads as "caching does not work"
    // rather than as a bug.
    expect(countCached()).toBe(1);
  });
});
