// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The one thing the client does beyond translating status codes: warn — once,
// throttled — when the decoder is UNREACHABLE, because that failure is otherwise
// silent (it degrades to transient-unavailable) and cost a self-hoster a debugging
// session. The distinctions under test are the whole point: a decoder that ANSWERS
// (even a 503) is not unreachable, and a recovery re-arms the warning.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decoderResolve } from './previewClient.js';

let stub: http.Server;
let stubUrl: string;
/** What the stub answers /resolve with; a test flips it. */
let stubStatus = 200;

const SAVED = process.env.LURKER_PREVIEWS_URL;
/** A port nothing listens on → connect refused with a syscall `code`, which is "unreachable". */
const DEAD_URL = 'http://127.0.0.1:1';

beforeAll(async () => {
  stub = http.createServer((_req, res) => {
    if (stubStatus === 503) {
      res.writeHead(503, { 'retry-after': '30' }).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ kind: 'page', title: 'x' }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (SAVED === undefined) delete process.env.LURKER_PREVIEWS_URL;
  else process.env.LURKER_PREVIEWS_URL = SAVED;
  await new Promise<void>((r) => stub.close(() => r()));
});

/** Every test starts from a clean warn latch — one reachable success zeroes it (that IS the
 *  reset-on-recovery path), so tests don't depend on each other's leftover throttle state. */
beforeEach(async () => {
  stubStatus = 200;
  process.env.LURKER_PREVIEWS_URL = stubUrl;
  await decoderResolve('https://example.com/reset', false);
});

describe('decoderResolve — unreachable-decoder warning', () => {
  it('warns once when the decoder cannot be reached, and throttles the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.LURKER_PREVIEWS_URL = DEAD_URL;
      const a = await decoderResolve('https://example.com/1', false);
      const b = await decoderResolve('https://example.com/2', false);
      expect(a.status).toBe('down');
      expect(b.status).toBe('down');
      // Two failures, ONE line — a link-heavy backlog must not become a wall of logs.
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('unreachable');
      expect(msg).toContain(DEAD_URL);
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT warn when the decoder answers, even with a 503 back-off', async () => {
    // A 503 is the decoder REACHABLE and speaking — "back off", not "you can't find me". Warning
    // here would cry wolf every time an origin rate-limited a preview.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stubStatus = 503;
      const out = await decoderResolve('https://example.com/limited', false);
      expect(out.status).toBe('backoff');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns again after the decoder recovers and breaks a second time', async () => {
    // The latch resets on any contact, so a later outage isn't swallowed by the first one's
    // throttle window. (beforeEach already did one reachable call; this proves the cycle.)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.LURKER_PREVIEWS_URL = DEAD_URL;
      await decoderResolve('https://example.com/down-1', false);
      expect(warn).toHaveBeenCalledTimes(1);

      // Recover: a reachable success clears the latch...
      process.env.LURKER_PREVIEWS_URL = stubUrl;
      await decoderResolve('https://example.com/up', false);

      // ...so the next outage warns afresh rather than staying quiet for the interval.
      process.env.LURKER_PREVIEWS_URL = DEAD_URL;
      await decoderResolve('https://example.com/down-2', false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
