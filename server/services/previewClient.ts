// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The cell's half of the lurker-previews seam (lurker-dev/LINK_PREVIEWS_ISOLATION.md).
//
// Everything that touches an origin or parses what one sent lives in the decoder
// now; this module is how the cell asks. Two calls, mirroring the decoder's two
// endpoints: `decoderResolve` for metadata verdicts, `decoderFetch` for image
// bytes. The decoder is configured by `LURKER_PREVIEWS_URL` and previews simply
// degrade to `unavailable` (transient, self-healing) when it is absent — there is
// deliberately NO in-cell fallback path, because two resolution paths is how the
// SSRF guard drifts.
//
// ⚠ This client does NOT go through anything like `safeRequest`, on purpose: the
// decoder lives at a private address, which is exactly what the origin-facing
// guard exists to refuse. The trust boundary here points the OTHER way — the
// decoder is the box expected to be compromised first, so its RESPONSES are data:
// `toDescriptor` still re-vets every embedUrl against the cell's own allowlist,
// and poster bytes still pass the byte cache's image-signature check before
// anything stores them.
//
// ⚠⚠ The status mapping is the contract's whole value. 502 ("dead", cache it for
// the failure TTL) and 503 ("back off", transient TTL and NO row) must never
// collapse — see the decoder's resolve.ts header for the shared table.

import http from 'node:http';
import https from 'node:https';
import type { PreviewKind } from '../db/linkPreviews.js';

/** The decoder answers its own /resolve inside 30 s; this only has to outlast it. */
const RESOLVE_TIMEOUT_MS = 32_000;
/** Metadata plus one base64 poster (a ≤640px q4 JPEG, tens of KB). 2 MB is margin. */
const MAX_RESOLVE_BODY = 2 * 1024 * 1024;
/** Connect-and-headers budget for a byte fetch; the BODY is unbounded in time here
 *  because the media route owns transfer pacing, exactly as it did against origins. */
const FETCH_HEADERS_TIMEOUT_MS = 25_000;

/**
 * Keep-alive is fine — desirable — on this hop: it is a private bridge to our own
 * container, so the pooled-socket-skips-the-DNS-guard trap that forces
 * `keepAlive: false` on origin fetches does not apply. One warm connection per
 * concurrent request instead of a handshake per image.
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const tlsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/** Read per call, not at module load, so tests (and a restartless reconfigure) see it. */
function baseUrl(): URL | null {
  const raw = process.env.LURKER_PREVIEWS_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export interface DecoderMeta {
  kind: PreviewKind;
  title: string | null;
  description: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  embedUrl: string | null;
  mime: string | null;
}

export interface DecoderPoster {
  jpeg: Buffer;
  width: number | null;
  height: number | null;
}

export type DecoderResolve =
  | { status: 'ok'; meta: DecoderMeta; poster: DecoderPoster | null }
  | { status: 'none' }
  | { status: 'refused'; reason: string }
  | { status: 'dead' }
  | { status: 'backoff'; retryAfterS: number }
  /** The decoder itself is unreachable, mid-deploy, or answering nonsense — a fact
   *  about this instant, never about the URL. Same treatment as pool saturation. */
  | { status: 'down' };

const KINDS: ReadonlySet<string> = new Set(['page', 'image', 'video', 'audio', 'video-embed']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pick the fields we know out of a decoder 200, refusing shapes we don't. */
function readMeta(body: unknown): { meta: DecoderMeta; poster: DecoderPoster | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) return null;
  const meta: DecoderMeta = {
    kind: b.kind as PreviewKind,
    title: str(b.title),
    description: str(b.description),
    siteName: str(b.siteName),
    author: str(b.author),
    imageUrl: str(b.imageUrl),
    imageWidth: num(b.imageWidth),
    imageHeight: num(b.imageHeight),
    embedUrl: str(b.embedUrl),
    mime: str(b.mime),
  };
  let poster: DecoderPoster | null = null;
  if (typeof b.poster === 'object' && b.poster !== null) {
    const p = b.poster as Record<string, unknown>;
    const b64 = str(p.jpegBase64);
    if (b64) {
      const jpeg = Buffer.from(b64, 'base64');
      if (jpeg.length > 0) poster = { jpeg, width: num(p.width), height: num(p.height) };
    }
  }
  return { meta, poster };
}

/** POST one JSON body, buffer one bounded JSON answer. Local plumbing, so plain. */
function post(
  base: URL,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const mod = base.protocol === 'https:' ? https : http;
    const req = mod.request(
      new URL(path, base),
      {
        method: 'POST',
        agent: base.protocol === 'https:' ? tlsAgent : agent,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESOLVE_BODY) {
            res.destroy();
            reject(new Error('decoder response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    // One deadline for the whole exchange: the decoder bounds its own work at 30 s, so
    // anything slower than that plus margin is a hung hop, not a slow origin.
    const deadline = setTimeout(() => req.destroy(new Error('decoder deadline')), timeoutMs);
    deadline.unref();
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * An unreachable decoder degrades to transient-unavailable and self-heals, so it must neither
 * throw nor spam — but a SILENT seam is undiagnosable, and that cost a self-hoster a debugging
 * session: settings on, container up, and nothing rendering with nothing in any log to say the
 * cell simply couldn't find the decoder. One throttled line names the cause and the usual fix
 * (the two containers not sharing a Docker network is almost always it).
 *
 * ⚠ Only SYSCALL-level failures count — a `code` like ENOTFOUND/ECONNREFUSED/ETIMEDOUT means
 * the seam itself is broken. A 502/503 is the decoder ANSWERING (reachable, just busy or
 * refusing), and our own deadline/abort errors carry no `code`; none of those are "unreachable".
 */
let lastUnreachableWarnMs = 0;
const UNREACHABLE_WARN_INTERVAL_MS = 60_000;
function noteDecoderUnreachable(err: unknown): void {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (typeof code !== 'string') return;
  const now = Date.now();
  if (now - lastUnreachableWarnMs < UNREACHABLE_WARN_INTERVAL_MS) return;
  lastUnreachableWarnMs = now;
  console.warn(
    `[lurker] link-preview decoder unreachable at ${process.env.LURKER_PREVIEWS_URL} (${code}) — ` +
      'previews will stay blank until the cell can reach it. The lurker and lurker-previews ' +
      'containers must share a Docker network.',
  );
}

/** Any contact with the decoder clears the warn latch, so a later outage warns afresh rather
 *  than staying quiet for the interval after one recovery. */
function noteDecoderReached(): void {
  lastUnreachableWarnMs = 0;
}

/**
 * Ask the decoder to resolve one URL. NEVER throws — every local failure is `down`.
 */
export async function decoderResolve(url: string, wantPoster: boolean): Promise<DecoderResolve> {
  // ⚠ Defensive: previewsEnabled() gates the whole feature on this same URL, so a caller
  // reaching here without one is a bug rather than a supported state — `down` degrades it to
  // transient-unavailable rather than throwing, but it should be unreachable in a running server.
  const base = baseUrl();
  if (!base) return { status: 'down' };
  try {
    const res = await post(base, '/resolve', { url, wantPoster }, RESOLVE_TIMEOUT_MS);
    noteDecoderReached();
    switch (res.status) {
      case 200: {
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.body.toString('utf8'));
        } catch {
          return { status: 'down' };
        }
        const read = readMeta(parsed);
        // A 200 whose shape we don't recognise is version skew mid-deploy: transient,
        // like every other fact about the seam rather than the URL.
        if (!read) return { status: 'down' };
        return { status: 'ok', meta: read.meta, poster: read.poster };
      }
      case 204:
        return { status: 'none' };
      case 403: {
        let reason = 'refused';
        try {
          const parsed = JSON.parse(res.body.toString('utf8')) as { reason?: unknown };
          if (typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
        } catch {
          // The status is the verdict; the reason is garnish for a log line.
        }
        return { status: 'refused', reason };
      }
      case 502:
        return { status: 'dead' };
      case 503: {
        const retry = Number(res.headers['retry-after']);
        return {
          status: 'backoff',
          retryAfterS: Number.isFinite(retry) && retry > 0 ? retry : 30,
        };
      }
      default:
        return { status: 'down' };
    }
  } catch (err) {
    noteDecoderUnreachable(err);
    return { status: 'down' };
  }
}

export interface DecoderFetchResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

/**
 * Ask the decoder for an image's bytes, as a stream the media route pipes onward.
 *
 * Rejects on a dead hop (no decoder, connect refused, headers never came) — the
 * route maps that to a transient 503, since "the decoder is mid-deploy" must not
 * become an <img>'s permanent 404. The returned stream is the caller's to destroy;
 * `signal` tears the request down when the caller gives up, exactly as it did
 * against origins — abandoning work is not the same as ending it.
 */
export function decoderFetch(
  url: string,
  range: string | undefined,
  signal: AbortSignal,
): Promise<DecoderFetchResponse> {
  return new Promise((resolve, reject) => {
    const base = baseUrl();
    if (!base) return reject(new Error('LURKER_PREVIEWS_URL is not configured'));
    if (signal.aborted) return reject(new Error('caller abandoned the request'));
    const payload = JSON.stringify({ url, ...(range ? { range } : {}) });
    const mod = base.protocol === 'https:' ? https : http;
    let settled = false;
    const req = mod.request(
      new URL('/fetch', base),
      {
        method: 'POST',
        agent: base.protocol === 'https:' ? tlsAgent : agent,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        settled = true;
        clearTimeout(deadline);
        noteDecoderReached();
        resolve({ status: res.statusCode || 0, headers: res.headers, stream: res });
      },
    );
    // Bounds connect-and-headers — the phase that can hang with nothing to show. The body
    // is the media route's to pace and tear down, same as it always was.
    const deadline = setTimeout(
      () => req.destroy(new Error('decoder headers deadline')),
      FETCH_HEADERS_TIMEOUT_MS,
    );
    deadline.unref();
    const onAbort = (): void => {
      req.destroy(new Error('caller abandoned the request'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
    });
    req.on('error', (err) => {
      if (settled) return;
      noteDecoderUnreachable(err);
      reject(err);
    });
    req.end(payload);
  });
}
