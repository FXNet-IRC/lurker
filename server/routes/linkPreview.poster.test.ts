// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The poster path end to end: a decoder hands back a first frame during resolve,
// the cell stores it in the byte cache, mints a `thumb` for the video card, and
// serves it from the dedicated route — the one byte URL in the system with no
// origin behind it, which is why every miss is an honest 404 rather than a
// re-fetch nothing could perform.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-poster');
process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'poster-cache');

let stub: StubDecoder;
let app: Express;
let agent: LurkerTestAgent;
let jpeg: Buffer;

beforeAll(async () => {
  stub = await startStubDecoder();
  const { createUser } = await import('../db/users.js');
  const router = (await import('./linkPreview.js')).default;
  const alice = createUser('alice-poster');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);
  // A real JPEG, because the byte cache's signature check is part of the path under test.
  jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#246' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await stub.close();
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  ctx.cleanup();
});

beforeEach(() => {
  stub.resolveAsks.length = 0;
});

async function resolveOne(url: string): Promise<Record<string, unknown>> {
  const res = await agent
    .post('/api/link-preview/resolve')
    .send({ urls: [url] })
    .expect(200);
  return res.body.previews[0] as Record<string, unknown>;
}

describe('a video card with a poster', () => {
  it('stores the frame, mints a thumb, and serves it back hardened', async () => {
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'video', imageUrl: 'https://cdn.example.com/clip.mp4', mime: 'video/mp4' },
      poster: { jpeg, width: 32, height: 18 },
    });

    const preview = await resolveOne('https://cdn.example.com/clip.mp4');
    expect(preview.kind).toBe('video');
    // The poster rides the byte cache being available, and the cell said so when it asked.
    expect(stub.resolveAsks[0]?.wantPoster).toBe(true);
    // A thumb, never a src — the poster is card decoration; the clip is still not relayed.
    expect(preview.src).toBeUndefined();
    // A signed token, not a bare key — the payload.sig shape the media route uses.
    expect(String(preview.thumb)).toMatch(/^\/api\/link-preview\/poster\/.+\..+$/);
    // The box the client reserves is the POSTER's shape.
    expect(preview.thumbWidth).toBe(32);
    expect(preview.thumbHeight).toBe(18);

    const served = await agent.get(String(preview.thumb)).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.headers['cache-control']).toBe('private, max-age=86400, immutable');
    expect(Buffer.from(served.body).equals(jpeg)).toBe(true);
  });

  it('refuses a poster that is not actually a JPEG, and the card just has no poster', async () => {
    // ⚠⚠ The trust boundary, exercised: the decoder is the box built to be compromised
    // first, so its "poster" is a CLAIM until the byte cache's signature check reads the
    // magic bytes. A decoder handing back HTML-in-a-poster must get nothing under the
    // cell's origin — and the failure must be a posterless card, never a failed resolve.
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'video', imageUrl: 'https://cdn.example.com/evil.mp4', mime: 'video/mp4' },
      poster: { jpeg: Buffer.from('<script>alert(1)</script>'), width: 32, height: 18 },
    });

    const preview = await resolveOne('https://cdn.example.com/evil.mp4');
    expect(preview.kind).toBe('video');
    expect(preview.status).toBe('ok');
    expect(preview.thumb).toBeUndefined();
    expect(preview.thumbWidth).toBeUndefined();
  });

  it('403s an unsigned or forged token, however well-formed', async () => {
    // The route serves nothing whose key it did not sign. A bare key, a bad key, an empty
    // token — all 403, the same answer the media route gives a forged token.
    for (const bad of ['not-a-token', 'e'.repeat(64), 'payload.badsig', 'poster:abc']) {
      const res = await agent.get(`/api/link-preview/poster/${encodeURIComponent(bad)}`);
      expect(`${bad} → ${res.status}`).toBe(`${bad} → 403`);
    }
  });

  it('404s a VALIDLY SIGNED token whose poster was never stored', async () => {
    // The honest miss: we signed this key (so 403 would be wrong), but nothing is cached
    // under it — evicted, cache cleared, or a token minted for a poster that never landed.
    const { mintPosterToken } = await import('../services/mediaProxyToken.js');
    const { posterCacheKey } = await import('../services/previewCache/index.js');
    const token = mintPosterToken(posterCacheKey('https://cdn.example.com/never-stored.mp4'));
    const res = await agent.get(`/api/link-preview/poster/${token}`);
    expect(res.status).toBe(404);
  });

  it('⚠⚠ refuses to serve a byte-cache object addressed by its computable key', async () => {
    // THE oracle. `byteCacheKey` is an unsalted hash any authenticated user can compute, and
    // it shares the cache index the poster route reads. First prove an image IS cached under
    // that key by proxying it through the (token-gated) media route...
    const url = 'https://cdn.example.com/someone-elses.png';
    const { mintProxyToken } = await import('../services/mediaProxyToken.js');
    stub.onFetch = (_u, res) => {
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(jpeg.length),
        'x-lurker-origin-framed': '1',
      });
      res.end(jpeg);
    };
    await agent.get(`/api/link-preview/media/${mintProxyToken(url)}`).expect(200);
    stub.onFetch = null;
    // ...then try to read it back through the poster route with the key alone. Pre-fix this
    // returned the bytes; the token requirement makes it a 403.
    const { byteCacheKey } = await import('../services/previewCache/index.js');
    const key = byteCacheKey(url);
    const res = await agent.get(`/api/link-preview/poster/${key}`);
    expect(res.status).toBe(403);
  });

  it('keeps audio symmetrical: cover art becomes the thumb, bytes stay unrelayed', async () => {
    stub.onResolve = () => ({
      status: 'ok',
      meta: { kind: 'audio', imageUrl: 'https://cdn.example.com/song.mp3', mime: 'audio/mpeg' },
      poster: { jpeg, width: 32, height: 18 },
    });
    const preview = await resolveOne('https://cdn.example.com/song.mp3');
    expect(preview.kind).toBe('audio');
    expect(preview.src).toBeUndefined();
    expect(String(preview.thumb)).toMatch(/^\/api\/link-preview\/poster\//);
  });
});
