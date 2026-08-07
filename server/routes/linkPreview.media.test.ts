// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The byte proxy against a real origin.
//
// Its own file because it needs the address policy inverted — the real guard blocks loopback,
// correctly, so nothing can watch this endpoint actually SERVE without it. The main route test
// keeps the real guard and covers refusal; this one covers what happens when a fetch succeeds,
// which was untested end to end: the headers, the caps, the range plumbing.
//
// ⚠ What's mocked is the POLICY, never the mechanism. Express, the token, the throttles, the
// pool, safeRequest, the pinned lookup and the pipe are all shipping code.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

vi.mock('../utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const ctx = setupTestDb('routes-link-preview-media');
process.env.LURKER_LINK_PREVIEWS = 'on';

let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;
/** How many times the ORIGIN was actually asked — the whole point of the hold. */
let originHits = 0;

/** A token for a path on the live origin, reached through `localhost` so the pinned lookup runs. */
const tokenFor = (path: string): string => mintProxyToken(`${base}${path}`);

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-media');
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
  ctx.cleanup();
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
    // script. One definition now — the route asks the resolver's `proxyableContentType`.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/logo.svg')}`);
    expect(res.status).toBe(404);
  });

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
    // zero — a seek that jumps back to the start.
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
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end('whole');
        return;
      }
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes 0-4/1000`,
        'content-length': '5',
      });
      res.end('parti');
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/clip.mp4')}`)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(res.headers['content-range']).toBe('bytes 0-4/1000');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('refuses a partial response whose RESOURCE is over the cap', async () => {
    // ⚠⚠ Regression guard. The cap only ever looked at Content-Length, which on a 206 is the
    // length of the PART — so a client asking for a 1 GB file one megabyte at a time satisfied
    // `declared <= cap` every single time and walked straight past a limit named for the
    // resource. The real size is the figure after the slash in Content-Range.
    handler = (_req, res) => {
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes 0-1023/${1024 * 1024 * 1024}`,
        'content-length': '1024',
      });
      res.end(Buffer.alloc(1024));
    };

    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/huge.mp4')}`)
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
      .get(`/api/link-preview/media/${tokenFor('/short.mp4')}`)
      .set('Range', 'bytes=9999-')
      .expect(416);
    expect(res.headers['content-range']).toBe('bytes */500');
  });

  it('answers 404, not 500, when the origin is simply not there', async () => {
    const token = mintProxyToken('http://127.0.0.1:1/nothing.png');
    const res = await agent.get(`/api/link-preview/media/${token}`);
    expect(res.status).toBe(404);
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

describe('holding and releasing the fetch slot', () => {
  // ⚠ These lines had no test at all — not the pool, not the 503, not the teardown — and three
  // of the review's findings lived in them. The mediaPool is instance-wide module state, so
  // these assertions are about what the ROUTE observably does with it.

  it('tears the origin connection down when the client goes away mid-FETCH', async () => {
    // ⚠⚠ Regression guard, and the timing is the whole test. The leak lives in the window
    // BEFORE `safeRequest` resolves — while there is a live request but no `upstream` to
    // destroy. An origin that answers immediately closes that window, so a version of this test
    // with a fast handler passes against the bug (mine did). This origin sits on the headers.
    //
    // What went wrong: `finish()` latched its done-flag with `upstream` still null, so the
    // destroy it existed for could never run, and the later call returned at its own guard. The
    // origin socket stayed live and unread, outside a pool that had already counted it free —
    // 'connect-then-abort as a cheap amplifier', which is what the comment claimed to prevent.
    //
    // Proved server-side: nothing client-side can see a socket we are still holding.
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
            res.writeHead(200, { 'content-type': 'video/mp4' });
            res.end('too late');
          }
        }, 3_000).unref();
      };
    });

    // ⚠ `.end()` to DISPATCH. A superagent request is lazy — it isn't sent until something
    // subscribes — so building one and aborting it proves nothing at all; the origin never sees
    // a connection and the assertion below waits forever for a close that cannot come.
    const req = agent.get(`/api/link-preview/media/${tokenFor('/abandoned.mp4')}`);
    req.end(() => {});
    await new Promise((r) => setTimeout(r, 150));
    req.abort();

    // Bounded, because "leaked" here means "still open", and waiting forever cannot tell the
    // two apart. A live guard closes it in milliseconds; the bug holds it for the 30 s idle
    // timeout that `streaming: true` installs.
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

describe('the resource-size cap on a partial response', () => {
  // ⚠ Each of these forms is legal, and each defeated the first version of `contentRangeTotal`
  // — with the inversion that made it worth its own describe: the more absurd the claimed size,
  // the more permissive the answer was.
  const partial = (contentRange: string): void => {
    handler = (_req, res) => {
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': contentRange,
        'content-length': '1024',
      });
      res.end(Buffer.alloc(1024));
    };
  };

  it('refuses a total it cannot represent instead of waving it through', async () => {
    // `Number('9'.repeat(400))` is Infinity, `Number.isFinite` said false, and the guard read
    // that as "no total stated, carry on".
    partial(`bytes 0-1023/${'9'.repeat(400)}`);
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/absurd.mp4')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(413);
  });

  it('refuses a Content-Range it cannot parse', async () => {
    partial('bytes 0-1023/not-a-number');
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/garbage.mp4')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(413);
  });

  it('judges the FIRST of a duplicated Content-Range, not the last', async () => {
    // node joins duplicates with ', ', and a `$`-anchored pattern read only the tail — so an
    // origin could state an acceptable size second and be believed.
    partial(`bytes 0-1023/${1024 * 1024 * 1024}, bytes 0-1023/1024`);
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/twohdr.mp4')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(413);
  });

  it('still serves a partial response whose total is genuinely unknown', async () => {
    // `bytes 0-N/*` is legal (RFC 7233 §4.2) and common for live-generated media. Refusing it
    // outright would be the other failure: the per-response byte counter is what bounds it.
    partial('bytes 0-1023/*');
    const res = await agent
      .get(`/api/link-preview/media/${tokenFor('/unknown.mp4')}`)
      .set('Range', 'bytes=0-1023');
    expect(res.status).toBe(206);
  });
});

describe('range advertisement', () => {
  it('reads Accept-Ranges as a token list, not a whole value', async () => {
    // ⚠ node joins a duplicated header, so a range-capable origin sending it twice arrives as
    // `'bytes, bytes'`. An equality test called that range-INCAPABLE, and Safari then refuses
    // to play the video at all — silently, since the card itself renders fine.
    handler = (_req, res) => {
      // Set as an array so node emits the header twice, which is the case under test.
      res.setHeader('Accept-Ranges', ['bytes', 'bytes']);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5' });
      res.end('whole');
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/dupehdr.mp4')}`);
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
  });
});

describe('a rate-limiting origin', () => {
  // ⚠⚠ FROM A REAL FAILURE ON A LIVE INSTANCE. `opengraph.githubassets.com` — where
  // every GitHub link's og:image lives — advertises a budget of 100 in
  // `x-ratelimit-*`. A channel with a run of GitHub links spends it in one burst
  // from the instance's single IP, and every image on that host went permanently
  // blank: the 429 was reported to the browser as 404, which an <img> treats as a
  // final answer and never re-asks.

  beforeEach(async () => {
    const { resetCooldownsForTests } = await import('../utils/originCooldown.js');
    resetCooldownsForTests();
    originHits = 0;
  });

  it('reports a 429 as 503 with Retry-After, not as a 404', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '42' });
      res.end();
    };
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/limited.png')}`);
    // ⚠ THE assertion. 404 is what an <img> caches as "this does not exist"; 503
    // leaves the door open for the reload that will succeed a minute later.
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('42');
  });

  it('stops asking a host that just refused, until its window passes', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '60' });
      res.end();
    };
    // Different images, same host — which is exactly the shape of a channel full
    // of GitHub links.
    const first = await agent.get(`/api/link-preview/media/${tokenFor('/a.png')}`);
    expect(first.status).toBe(503);
    expect(originHits).toBe(1);

    for (const p of ['/b.png', '/c.png', '/d.png']) {
      const res = await agent.get(`/api/link-preview/media/${tokenFor(p)}`);
      expect(res.status).toBe(503);
    }
    // ⚠⚠ THE POINT. One request went out; the rest were answered from the hold.
    // Without it each of those spends another unit of a budget that is already
    // exhausted, so it can never recover — the failure sustains itself.
    expect(originHits).toBe(1);
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
