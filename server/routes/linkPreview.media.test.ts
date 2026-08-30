// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The byte relay against a live origin, through a contract-faithful decoder stub.
//
// Since the lurker-previews split the cell never dials an origin — the decoder
// does — so what this file pins is the CELL's half of the byte path: the token,
// the throttles, the pool, the hardening headers, the cache tee, and the
// translation of the decoder's precise statuses into what an <img> can act on.
// The decoder's own half (the SSRF guard, the caps at the origin side, the
// cooldown, the Accept-Ranges token match) is pinned in the lurker-previews repo;
// the stub here implements its documented contract, and origin fixtures stay
// because the stub relays them — so an origin misbehaving still reaches the cell
// as the decoder would report it.
//
// ⚠ No ipGuard mock any more, and that is the feature: nothing in this process
// judges addresses now. The stub dials the loopback origins the way the real
// decoder dials real ones.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-media');

let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let stub: StubDecoder;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;
/** A token for a path on the live origin. */
const tokenFor = (path: string): string => mintProxyToken(`${base}${path}`);

beforeAll(async () => {
  stub = await startStubDecoder();
  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-media');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);

  origin = http.createServer((req, res) => {
    handler(req, res);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  await stub.close();
  ctx.cleanup();
});

beforeEach(() => {
  stub.onFetch = null;
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('serving bytes', () => {
  it('streams an image back under our own origin, with the hardening headers', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    };

    const res = await agent.get(`/api/link-preview/media/${tokenFor('/a.png')}`).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('private, max-age=86400, immutable');
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('refuses SVG even though the origin calls it an image', async () => {
    // The allowlist is the point: these bytes are served under OUR origin, and SVG executes
    // script. The decoder refuses it at its end (that's what the stub implements); the test
    // two below proves the cell would refuse it AGAIN if the decoder didn't.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/logo.svg')}`);
    expect(res.status).toBe(404);
  });

  it('re-checks the content type itself when a MISBEHAVING decoder relays one', async () => {
    // ⚠⚠ The trust boundary points the unusual way on this seam: the decoder is the box
    // built to be compromised first, so its responses are DATA. A decoder that answers
    // `text/html` — through a bug, a skew, or an owner — must not get script under the
    // cell's origin just because the guard on its side stopped guarding.
    stub.onFetch = (_url, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/evil.html')}`);
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain('alert');
  });

  it('refuses SVG whose content-type carries a charset parameter', async () => {
    // ⚠⚠ Regression guard. `kindForContentType` refuses SVG by an EXACT `=== 'image/svg+xml'`
    // match, so a relay handing back `image/svg+xml; charset=utf-8` (parameters intact) slips
    // past it into `startsWith('image/')` and is served inline under our origin. The route now
    // strips parameters before the allowlist; a param-less test could never have caught this.
    stub.onFetch = (_url, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/param.svg')}`);
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain('alert');
  });

  it('serves an image whose content-type is uppercase or parameterised', async () => {
    // The other side of normalising: `IMAGE/PNG` and `image/png; name=x` are the same allowed
    // kind, and a bare equality check would 404 them. (The pre-normalisation code did.)
    stub.onFetch = (_url, res) => {
      res.writeHead(200, { 'content-type': 'IMAGE/PNG; name=shot.png' });
      res.end(PNG);
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/shouty.png')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  // ⚠⚠ THE MEDIA-POLICY CONTRACT, asserted at the enforcement point rather than only at the
  // mint. `toDescriptor` no longer hands out a `src` for these kinds, so in normal operation
  // nothing asks — but a token is a pure HMAC of the URL, so a descriptor minted before the
  // change (sitting in an open tab, or replayed by anyone who kept one) still verifies. The
  // route is what has to say no, and saying no here is what makes the relay actually gone
  // rather than merely unadvertised. The policy is stated for operators under "Link previews
  // & inline media" in docs/SELF_HOSTING.md.
  for (const [kind, contentType, path] of [
    ['video', 'video/mp4', '/clip.mp4'],
    ['video', 'video/quicktime', '/phone.mov'],
    ['audio', 'audio/mpeg', '/song.mp3'],
  ] as const) {
    it(`refuses ${contentType}: ${kind} is never relayed, at any size`, async () => {
      // ⚠ A TINY body, deliberately. Refusing a 44 MB clip could be explained by a size
      // ceiling; refusing five bytes can only be explained by the kind. That is the property
      // under test — there is no longer a size at which video is served.
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': contentType, 'content-length': '5' });
        res.end('bytes');
      };
      const res = await agent.get(`/api/link-preview/media/${tokenFor(path)}`);
      // ⚠ 404, not 413. A size ceiling would be the wrong answer twice over: it implies a
      // smaller clip would be served, and `MAX_MEDIA_PROXY_BYTES` no longer exists to name one.
      expect(res.status).toBe(404);
      // ⚠⚠ None of the origin's bytes reached the client, and the response does not wear the
      // media type. Status alone would pass if the route 404'd a header while still piping the
      // body — which is exactly the shape of the bug this whole change is about.
      expect(res.text ?? '').not.toContain('bytes');
      expect(res.headers['content-type'] ?? '').not.toContain(contentType);
    });
  }

  it('refuses text/html, which is the other way to get script into our origin', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/page.html')}`);
    expect(res.status).toBe(404);
  });

  it('does not claim to accept ranges when the origin ignored them', async () => {
    // ⚠ Advertising `Accept-Ranges: bytes` for a source that ignores Range makes a media
    // element seek by asking for a range and then silently receive the whole file from byte
    // zero — a seek that jumps back to the start. The token-match rule lives in the decoder
    // now; what this pins is that the cell forwards its absence as absence.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/b.png')}`).expect(200);
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('forwards a range, and says so, when the origin honours one', async () => {
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('whole');
        return;
      }
      res.writeHead(206, {
        'content-type': 'image/png',
        'content-range': `bytes 0-4/1000`,
        'content-length': '5',
      });
      res.end('parti');
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/clip.png')}`)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(res.headers['content-range']).toBe('bytes 0-4/1000');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('refuses a partial response whose RESOURCE is over the cap', async () => {
    // ⚠⚠ Regression guard. The cap only ever looked at Content-Length, which on a 206 is the
    // length of the PART — so a client asking for a 1 GB file one megabyte at a time satisfied
    // `declared <= cap` every single time and walked straight past a limit named for the
    // resource. The real size is the figure after the slash in Content-Range. The check runs
    // in the decoder now; the 413 must survive the seam untranslated.
    handler = (_req, res) => {
      res.writeHead(206, {
        'content-type': 'image/png',
        'content-range': `bytes 0-1023/${1024 * 1024 * 1024}`,
        'content-length': '1024',
      });
      res.end(Buffer.alloc(1024));
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/huge.png')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(413);
  });

  it('refuses a whole response that declares itself over the cap', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(64 * 1024 * 1024),
      });
      res.end(PNG);
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/huge.png')}`);
    expect(res.status).toBe(413);
  });

  it('passes an unsatisfiable range through as 416 rather than 404', async () => {
    // A media element knows what to do with 416 — it means "that range doesn't exist", not
    // "the file doesn't exist", and collapsing the two makes a bad seek look like a dead link.
    handler = (_req, res) => {
      res.writeHead(416, { 'content-range': 'bytes */500' });
      res.end();
    };
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/short.png')}`)
      .set('Range', 'bytes=9999-')
      .expect(416);
    expect(res.headers['content-range']).toBe('bytes */500');
  });

  it('answers 404, not 500, when the origin is simply not there', async () => {
    // A dead origin is the decoder's 502, and 502 is a permanent verdict for an <img> —
    // the one status the cell folds to 404 on purpose.
    const token = mintProxyToken('http://127.0.0.1:1/nothing.png');
    const res = await agent.get(`/api/link-preview/media/${token}`);
    expect(res.status).toBe(404);
  });

  it('answers 503 with Retry-After when the DECODER itself is unreachable', async () => {
    // ⚠ The new failure mode this seam introduces, and it must not wear 404: the decoder
    // being mid-deploy for thirty seconds must not become "this image does not exist" in
    // every open tab for a day.
    const saved = process.env.LURKER_PREVIEWS_URL;
    process.env.LURKER_PREVIEWS_URL = 'http://127.0.0.1:1';
    try {
      const res = await agent.get(`/api/link-preview/media/${tokenFor('/a.png')}`);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeTruthy();
    } finally {
      process.env.LURKER_PREVIEWS_URL = saved;
    }
  });

  it('survives a token whose signature is the right length in the wrong encoding', async () => {
    // ⚠ Regression guard, reached through the ROUTE because that is where it hurt: the length
    // guard compared UTF-16 code units while timingSafeEqual compares bytes, so this threw a
    // RangeError from above the handler's try — a 500 and a logged stack, where the endpoint's
    // whole answer to a bad token is 403.
    const token = tokenFor('/a.png');
    const payload = token.slice(0, token.lastIndexOf('.'));
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const res = await agent.get(
      `/api/link-preview/media/${payload}.${encodeURIComponent(`é${'a'.repeat(sig.length - 1)}`)}`,
    );
    expect(res.status).toBe(403);
  });
});

describe('holding and releasing the relay slot', () => {
  it('tears the whole chain down when the client goes away mid-FETCH', async () => {
    // ⚠⚠ Regression guard, and the timing is the whole test. The leak lives in the window
    // BEFORE the upstream resolves — while there is a live request but no stream to
    // destroy. An origin that answers immediately closes that window, so a version of this
    // test with a fast handler passes against the bug. This origin sits on the headers.
    //
    // The chain is a hop longer now (client → cell → stub → origin) and the property is the
    // same: the abort must PROPAGATE, because a torn-down cell request that leaves the
    // decoder's origin fetch running has just moved the amplifier one box over.
    let closedEarly = false;
    const settled = new Promise<void>((resolve) => {
      handler = (req, res) => {
        res.on('error', () => {});
        // Torn down from our end before the origin ever answered.
        req.on('close', () => {
          closedEarly = !res.headersSent;
          resolve();
        });
        // Deliberately slow: the fetch is still in flight when the client leaves.
        setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end('too late');
          }
        }, 3_000).unref();
      };
    });

    // ⚠ `.end()` to DISPATCH. A superagent request is lazy — it isn't sent until something
    // subscribes — so building one and aborting it proves nothing at all.
    const req = agent.get(`/api/link-preview/media/${tokenFor('/abandoned.png')}`);
    req.end(() => {});
    await new Promise((r) => setTimeout(r, 150));
    req.abort();

    // Bounded, because "leaked" here means "still open", and waiting forever cannot tell the
    // two apart.
    const raced = await Promise.race([
      settled.then(() => 'closed' as const),
      new Promise<'leaked'>((r) => setTimeout(() => r('leaked'), 2_000)),
    ]);
    expect(raced).toBe('closed');
    expect(closedEarly).toBe(true);
  }, 20_000);

  it('gives the slot back after an ordinary response, so the pool does not leak', async () => {
    // A pool that never releases looks fine until the 24th request of the process. Serving more
    // than the pool size in sequence is the cheapest assertion that release actually runs.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    };
    for (let i = 0; i < 30; i++) {
      const res = await agent.get(`/api/link-preview/media/${tokenFor(`/seq-${i}.png`)}`);
      expect(`${i} → ${res.status}`).toBe(`${i} → 200`);
    }
  }, 30_000);

  it('gives the slot back after a refusal too', async () => {
    // The error paths release through the same `close` listener. If they didn't, a run of dead
    // origins would retire the pool a slot at a time.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script>alert(1)</script>');
    };
    for (let i = 0; i < 30; i++) {
      const res = await agent.get(`/api/link-preview/media/${tokenFor(`/refused-${i}.html`)}`);
      expect(`${i} → ${res.status}`).toBe(`${i} → 404`);
    }
  }, 30_000);
});

describe('a rate-limiting origin', () => {
  // ⚠⚠ FROM A REAL FAILURE ON A LIVE INSTANCE (opengraph.githubassets.com's budget of 100).
  // The cooldown that stops re-asking a 429ing host MOVED to the decoder along with the
  // fetches — its own repo pins that behaviour now. What must survive on THIS side of the
  // seam is the status translation: a 503 stays a 503 with its Retry-After, because 404 is
  // what an <img> caches as "this does not exist" and never re-asks.

  it('reports a 429 as 503 with Retry-After, not as a 404', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '42' });
      res.end();
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/limited.png')}`);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('42');
  });

  it('keeps reporting a 404 as a 404', async () => {
    // ⚠ "Not now" and "not ever" must stay distinguishable. A genuinely missing
    // image is a fact about that URL, and an <img> that stops asking is correct.
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/gone.png')}`);
    expect(res.status).toBe(404);

    // ...and a permanent failure must NOT bench the host for everything else.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    };
    const ok = await agent.get(`/api/link-preview/media/${tokenFor('/fine.png')}`);
    expect(ok.status).toBe(200);
  });
});
