// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { PreviewRecord } from './linkPreviews.js';

const ctx = setupTestDb('db-link-previews');

let mod: typeof import('./linkPreviews.js');
let db: typeof import('./index.js').default;

beforeAll(async () => {
  mod = await import('./linkPreviews.js');
  db = (await import('./index.js')).default;
});

afterAll(() => ctx.cleanup());

function record(url: string, over: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    url,
    status: 'ok',
    kind: 'page',
    title: 'A Title',
    description: null,
    siteName: null,
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: null,
    posterKey: null,
    expiresAt: new Date(Date.now() + mod.OK_TTL_MS).toISOString(),
    ...over,
  };
}

describe('expiry', () => {
  it('ranks a same-day timestamp correctly, where the old form did not', () => {
    // ⚠⚠ The real guard, and it is deliberately free of `Date.now()`. The behavioural test
    // below only CATCHES this bug when the lapsed timestamp shares a calendar date with now —
    // so after UTC midnight it goes green with the fix reverted, and nightly CI commonly runs
    // exactly then. Asserted against fixed literals instead: no clock, no date arithmetic, and
    // it fails at any hour of any day.
    //
    // The defect: `expires_at` is ISO-8601 (`…T10:59:00.000Z`) while `datetime('now')` yields
    // `… 11:00:00`, SQLite compares TEXT lexicographically, and 'T' (0x54) sorts after ' '
    // (0x20) — so a row that lapsed a minute ago read as still live until midnight UTC.
    const lapsed = '2026-07-30T10:59:00.000Z';
    // ⚠ Built from the module's OWN expression with a fixed instant swapped in for `'now'`.
    // Spelling the strftime out here instead would assert a fact about SQLite and stay green
    // when the shipped line changes — which it did, on the first draft of this test.
    const at = (instant: string): string => {
      const expr = mod.NOW_ISO.replace("'now'", `'${instant}'`);
      expect(expr).not.toBe(mod.NOW_ISO); // the substitution has to have happened
      return expr;
    };
    const row = db
      .prepare(
        `SELECT (? > ${at('2026-07-30 11:00:00')}) AS shipped,
                (? > datetime('2026-07-30 11:00:00')) AS old`,
      )
      .get(lapsed, lapsed) as { shipped: number; old: number };

    expect(row.shipped).toBe(0); // correctly lapsed
    expect(row.old).toBe(1); // the bug: an hour-old expiry reads as still live
  });

  it('treats a lapsed row as absent even when it lapsed today', async () => {
    // ⚠ Regression guard. `expires_at` is stored ISO-8601 (`…T11:00:00.000Z`) while
    // `datetime('now')` yields `… 11:00:00`, and SQLite compares TEXT lexicographically where
    // 'T' (0x54) sorts after ' ' (0x20) — so a bare comparison answered "still live" for every
    // expiry on the same calendar date. A one-hour negative TTL survived until midnight UTC.
    const url = 'https://e.test/lapsed';
    mod.putPreview(record(url, { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(mod.getCachedPreview(url)).toBeNull();

    const live = 'https://e.test/live';
    mod.putPreview(record(live, { expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(mod.getCachedPreview(live)?.title).toBe('A Title');
  });

  it('sweeps only what has lapsed', () => {
    const stale = 'https://e.test/sweep-me';
    mod.putPreview(record(stale, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const fresh = 'https://e.test/keep-me';
    mod.putPreview(record(fresh));

    expect(mod.sweepExpiredPreviews()).toBeGreaterThanOrEqual(1);
    expect(mod.getCachedPreview(stale)).toBeNull();
    expect(mod.getCachedPreview(fresh)?.title).toBe('A Title');
  });

  it('can use the expiry index rather than scanning the table', () => {
    // ⚠⚠ The fix for the comparison above was `datetime(expires_at) <= datetime('now')`, which
    // is correct and NON-SARGABLE: wrapping the column in a function makes
    // idx_link_previews_expires unusable, so the index is maintained on every upsert and read
    // by nothing, and the sweep — which runs at boot and hourly, synchronously, on the one
    // shared connection — becomes a full scan of a table with a 7-day TTL. Asserted through the
    // planner because that is the only thing that actually knows.
    //
    // ⚠⚠ Planned from the module's OWN exported SQL, not a copy of it. Written against a
    // hand-pasted query this test stayed green with the fix reverted — proving only that
    // SQLite can use an index for a string the test made up, which is a comment wearing a
    // test's clothes. It is the shipped statement or it is nothing.
    const planOf = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' ');

    const sweep = planOf(mod.SWEEP_SQL);
    expect(sweep).toContain('idx_link_previews_expires');
    expect(sweep).not.toContain('SCAN link_previews');

    // ...and the form it replaced does not, which is what makes the assertion above mean
    // something rather than restate whatever the planner happens to do.
    const wrapped = planOf(
      `DELETE FROM link_previews WHERE datetime(expires_at) <= datetime('now')`,
    );
    expect(wrapped).toContain('SCAN link_previews');
  });
});

describe('the cache key', () => {
  const urlHash = (url: string): string => mod.urlHash(url);

  it('collapses every form of one URL that normalizeUrl collapses', () => {
    // ⚠ Regression guard. The key was the raw request string with a `/#.*$/` strip, which
    // handled one of these four and left the rest as separate rows — the same page paying for
    // several scrapes, several TTLs, and a one-character cache bypass for anyone authenticated
    // (vary the host's case and every ask is a fresh outbound fetch).
    const canonical = urlHash('https://e.test/a');
    expect(urlHash('https://E.TEST/a')).toBe(canonical); // host case
    expect(urlHash('https://e.test:443/a')).toBe(canonical); // default port
    expect(urlHash('https://e.test/b/../a')).toBe(canonical); // dot segments
    expect(urlHash('https://e.test/a#intro')).toBe(canonical); // fragment
    expect(urlHash('https://e.test/a#appendix')).toBe(canonical);
  });

  it('keeps genuinely different URLs apart', () => {
    const a = urlHash('https://e.test/a');
    expect(urlHash('https://e.test/A')).not.toBe(a); // paths ARE case-sensitive
    expect(urlHash('http://e.test/a')).not.toBe(a); // scheme is part of the identity
    expect(urlHash('https://e.test/a?q=1')).not.toBe(a);
  });

  it('collapses fragments for a URL the fetcher refuses, too', () => {
    // ⚠ Regression guard for a fallback that quietly revoked the rule above. Keying through
    // `normalizeUrl` meant every URL it REFUSED — a private literal, a bad scheme — fell
    // through to the raw string, so `#a` and `#b` of one blocked address became two rows and
    // two independent negative TTLs. The identity of a cached thing should depend on the thing,
    // not on what the address policy thinks of it. (The earlier version of this test asserted
    // `urlHash(x) === urlHash(x)`, which is `f(x) === f(x)` and could not have noticed.)
    const blocked = urlHash('http://10.0.0.1/x');
    expect(urlHash('http://10.0.0.1/x#a')).toBe(blocked);
    expect(urlHash('http://10.0.0.1/x#b')).toBe(blocked);
    // ...while still telling two different blocked hosts apart.
    expect(urlHash('http://10.0.0.2/x')).not.toBe(blocked);
  });

  it('keys something that is not a URL at all without throwing', () => {
    const junk = urlHash('not a url');
    expect(junk).toMatch(/^[0-9a-f]{64}$/);
    expect(urlHash('not a url#anchor')).toBe(junk);
  });
});
