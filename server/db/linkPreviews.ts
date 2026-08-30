// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'node:crypto';
import db from './index.js';

/** What a resolved URL turned out to be. Decided from Content-Type, never from
 *  the file extension — the extension is only ever a client-side hint about
 *  which setting *would* cover a URL. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'page' | 'video-embed';
export type PreviewStatus = 'ok' | 'unavailable';

export interface PreviewRecord {
  url: string;
  status: PreviewStatus;
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
  /** Byte-cache key of a stored poster frame — video/audio kinds only, and only when the
   *  poster was actually stored. ⚠ For those rows, `imageWidth`/`imageHeight` describe the
   *  POSTER (they were always null for video before posters existed); `imageUrl` still names
   *  the media itself and is never minted into a byte URL for these kinds. */
  posterKey: string | null;
  expiresAt: string;
}

/** Successful metadata is stable — a page's og:title rarely changes, and if it
 *  does, a week-late card is a non-event. */
export const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failures get a much shorter life: a 403 or a timeout is often transient (the
 *  site was down, we got challenged once), and we want another go before long —
 *  just not on every scroll. */
export const FAIL_TTL_MS = 60 * 60 * 1000;

/**
 * Bumped whenever the resolver would produce a DIFFERENT RECORD for the same input.
 *
 * Folded into the cache key, so a bump orphans every old row rather than requiring a schema
 * change or a manual flush — the expiry sweep collects them in its own time.
 *
 * ⚠ It is a BLUNT instrument, and worth costing before reaching for it. It orphans every row of
 * every kind, not the affected ones, so the whole table is re-fetched from its origins; with
 * `MAX_CONCURRENT` at 20 instance-wide and a 10 s queue wait, a busy first load after deploy can
 * hand back `unavailable` for links that would have been cache hits, and those wait out the
 * re-ask ladder. And it reaches a running client slowly: previews resolve at message INGEST and
 * an `ok` entry is never re-asked before its own `expiresAt`, so an open tab keeps rendering
 * what it already has until a reload — a bump is not a push. Where the affected rows are
 * describable by a predicate, a one-shot boot migration (`db/migrateEventMode.ts` and its
 * siblings) targets them without disturbing anything else.
 *
 * This is not hypothetical bookkeeping. During development the YouTube fix was invisible for
 * an hour after it shipped, because the previous code had already cached
 * `youtube.com/watch?v=…` as `unavailable` and the negative TTL had not lapsed. A fix that
 * can't be observed is a fix that gets re-debugged.
 *
 * ⚠ Starts at 1, deliberately, even though the resolver was rewritten several times before
 * this point: the table has never existed in a release, so there are no v0 rows anywhere to
 * orphan and a higher number would only imply a version somebody ran.
 *
 * ⚠⚠ A DIFFERENT RECORD, not only a different VERDICT. This said "could turn a stored
 * `unavailable` into an `ok`" for two versions, and that reads as the whole test when it is only
 * the loudest case: a change that fills in a FIELD leaves every affected row a perfectly good
 * `ok`, so nothing looks stale anywhere and the new value is simply missing for a week on every
 * URL anyone had already pasted. From outside a process that is indistinguishable from the
 * feature never having worked, which is how it gets reported.
 *
 * Say what changed on the line below.
 *
 *   v1 — initial.
 *   v2 — a video embed survives a page with no title and no image (a rate-limited provider
 *        call used to discard the embed URL it was holding); an unusable oEmbed thumbnail no
 *        longer discards the scraped og:image alongside it. Both turn stored `unavailable`
 *        rows into `ok` ones, which is precisely what this counter is for — and the `urlHash`
 *        rewrite in the same change is NOT a substitute, because it produces byte-identical
 *        hashes for canonically-spelled URLs and so orphans none of the affected rows.
 *   v3 — #697 taught `imageDimensions` to measure WebP and GIF headers sharp refuses to read, so
 *        `kind: 'image'` rows now carry dimensions where they stored null. ⚠ Owed by that change
 *        and not taken with it: every such row cached before it is still a live hit with no
 *        dimensions, so `toDescriptor` omits `thumbWidth`, the client reserves `.dim-reserve`
 *        instead of the picture's own aspect, and the QA report #697 was merged to fix ("solo
 *        .webp renders with the fallback placeholder, .png doesn't") is still true for every one
 *        of them. A different record for the same input, with no change of verdict — exactly the
 *        case the rule above was widened to cover, which is how it was found.
 *
 *        ⚠ Taken as a full bump rather than the narrower `kind='image' AND image_width IS NULL`
 *        a targeted migration could use, because the blunt cost is not a cost here: link
 *        previews have not shipped to anyone, so there is no cache in the world worth keeping.
 *        A later bump against a live fleet should weigh that predicate instead.
 *   v4 — `scrapeMeta` now reads `og:image:width`/`og:image:height`, so `kind: 'page'` rows carry
 *        the declared shape of their card image where they stored null. Squarely the
 *        fills-in-a-FIELD case this comment warns about two paragraphs up: every page row cached
 *        before this is a live, perfectly valid `ok` with no dimensions on it, and the client
 *        reads their absence as "no declared shape" — which is the HERO default. So without the
 *        bump, every link anyone had already pasted would render a logo as a stretched band for
 *        a week, and only newly-seen URLs would come out right. Nothing about that presents as
 *        a stale cache.
 *   v5 — resolution moved into the lurker-previews decoder, and video/audio rows gained
 *        `posterKey` (a stored first frame) with the poster's shape in image_width/height.
 *        The fills-in-a-FIELD case again: every video row cached before this is a live `ok`
 *        that would render posterless for up to a week while newly-pasted clips get frames.
 */
const RESOLVER_VERSION = 5;

/**
 * Cache key: the requested URL, scoped to the resolver version.
 *
 * ⚠ Keyed on the URL **as asked for**, never on where it ended up after redirects. Getting
 * this wrong was a two-headed bug: the client looks a preview up by the string it sent, so a
 * descriptor echoing the post-redirect URL silently never matched and the preview never
 * rendered — and the cache was written under a key nothing would ever read, so every single
 * resolve of a redirecting URL went back out to the origin. `http://en.wikipedia.org/wiki/IRC`
 * refetched forever and displayed nothing.
 */
export function urlHash(url: string): string {
  // ⚠ The CANONICAL form, from the same function the fetcher uses, not a hand-rolled strip.
  //
  // The fragment is client-side only and never reaches the origin, so `#intro` and `#appendix`
  // of one document are the same fetch — but so are `https://E.test/a` and `https://e.test/a`,
  // and `https://e.test` and `https://e.test/`, and `https://e.test:443/a` and
  // `https://e.test/a`. `normalizeUrl` already collapses every one of those (it lowercases the
  // host, drops the default port, resolves dot-segments, and strips the fragment for exactly
  // this stated reason); keying the raw string with a `/#.*$/` regex collapsed one case out of
  // four, so the same page paid for two scrapes, two rows and two TTLs whenever it was pasted
  // in two forms. It is also a one-character cache bypass for any authenticated client: vary
  // the case of the host and every request is a fresh outbound fetch.
  //
  // ⚠ Canonicalised by `URL` itself, NOT by `normalizeUrl`. They agree on every URL
  // `normalizeUrl` accepts — it returns the parsed URL with the fragment cleared, which is
  // exactly this — but routing through it had two costs. It made the cache key a function of
  // the SSRF ADDRESS POLICY, so adding a prefix to `isBlockedIpLiteral` would silently re-key
  // every cached row in that range from a file with no connection to the resolver. And its
  // refusals fell through to the raw string, which quietly revoked the fragment collapse for
  // exactly those URLs: `http://10.0.0.1/x#a` and `#b` became two rows and two TTLs, for inputs
  // the comment below promises still get one negative row.
  //
  // The identity of a cached thing should depend on the thing, not on what we think of it.
  let key: string;
  try {
    const canonical = new URL(url);
    canonical.hash = '';
    key = canonical.toString();
  } catch {
    // Not a URL at all. It still gets a negative row, keyed by what was asked minus the
    // fragment, so anchors of one unparseable string share it like anchors of any other.
    key = url.replace(/#[\s\S]*$/, '');
  }
  return crypto.createHash('sha256').update(`v${RESOLVER_VERSION}|${key}`).digest('hex');
}

/**
 * `now`, in exactly the format `expires_at` is stored in.
 *
 * ⚠ Both halves of this matter, and the obvious fix for the first breaks the second.
 *
 * `expires_at` is written as ISO-8601 (`2026-07-30T11:00:00.000Z`) while `datetime('now')`
 * yields `2026-07-30 11:00:00` — and SQLite compares TEXT lexicographically, where 'T' (0x54)
 * sorts after ' ' (0x20). So a bare comparison against `datetime('now')` always answered "still
 * live" for any expiry on the same calendar date: a 1-hour failure TTL survived until midnight
 * UTC. Wrapping both sides in `datetime()` fixes that — and makes the column NON-SARGABLE, so
 * `idx_link_previews_expires` becomes unusable by every query that exists. Verified with EXPLAIN
 * QUERY PLAN: `datetime(expires_at) <= datetime('now')` plans `SCAN link_previews`, while a bare
 * comparison plans `SEARCH ... USING INDEX idx_link_previews_expires`. The sweep runs at boot and
 * hourly, synchronously, on the one shared connection — a full scan of a URL-keyed table with a
 * 7-day TTL is the event-loop stall this repo already instruments for.
 *
 * Rendering `now` into the stored format keeps both: instants compare correctly BECAUSE
 * ISO-8601-with-Z is lexicographically ordered, and the index is usable because the column is
 * untouched.
 */
/** ⚠ Exported so a test can substitute a fixed instant for `'now'` and assert the ranking
 *  deterministically. A test that spells the expression out itself asserts a fact about SQLite
 *  rather than about this module, and stays green when this line changes. */
export const NOW_ISO = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/** ⚠ Exported so a test can EXPLAIN the statements that ACTUALLY run. Planning a paraphrase
 *  proves nothing: an index assertion written against a hand-copied string stays green when the
 *  shipped query changes underneath it, which is a comment wearing a test's clothes. */
export const SELECT_SQL = `
  SELECT * FROM link_previews
  WHERE url_hash = ? AND expires_at > ${NOW_ISO}
`;
export const SWEEP_SQL = `DELETE FROM link_previews WHERE expires_at <= ${NOW_ISO}`;

const selectStmt = db.prepare(SELECT_SQL);

const upsertStmt = db.prepare(`
  INSERT INTO link_previews (
    url_hash, url, status, kind, title, description, site_name, author,
    image_url, image_width, image_height, embed_url, mime, poster_key, fetched_at, expires_at
  ) VALUES (
    @urlHash, @url, @status, @kind, @title, @description, @siteName, @author,
    @imageUrl, @imageWidth, @imageHeight, @embedUrl, @mime, @posterKey, datetime('now'), @expiresAt
  )
  ON CONFLICT(url_hash) DO UPDATE SET
    status = excluded.status, kind = excluded.kind, title = excluded.title,
    description = excluded.description, site_name = excluded.site_name,
    author = excluded.author, image_url = excluded.image_url,
    image_width = excluded.image_width, image_height = excluded.image_height,
    embed_url = excluded.embed_url, mime = excluded.mime, poster_key = excluded.poster_key,
    fetched_at = datetime('now'), expires_at = excluded.expires_at
`);

const sweepStmt = db.prepare(SWEEP_SQL);

interface Row {
  url: string;
  status: string;
  kind: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  author: string | null;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  embed_url: string | null;
  mime: string | null;
  poster_key: string | null;
  expires_at: string;
}

function toRecord(row: Row): PreviewRecord {
  return {
    url: row.url,
    status: row.status as PreviewStatus,
    kind: row.kind as PreviewKind,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    author: row.author,
    imageUrl: row.image_url,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    embedUrl: row.embed_url,
    mime: row.mime,
    posterKey: row.poster_key,
    expiresAt: row.expires_at,
  };
}

/** A live cache entry for this URL, or null on miss/expiry. */
export function getCachedPreview(url: string): PreviewRecord | null {
  const row = selectStmt.get(urlHash(url)) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function putPreview(record: PreviewRecord): void {
  upsertStmt.run({ ...record, urlHash: urlHash(record.url) });
}

/** Drop lapsed rows. Wired to a timer in server.ts — the table is a cache, so this is
 *  housekeeping rather than correctness, but without it the table only ever grows. */
export function sweepExpiredPreviews(): number {
  return sweepStmt.run().changes;
}
