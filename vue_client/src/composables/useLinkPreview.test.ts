// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  primePreviews,
  useLinkPreview,
  usePreviewsSettled,
  previewRevision,
  resetLinkPreviewCache,
} from './useLinkPreview.js';
import * as apiModule from '../api.js';
import { ref, watch } from 'vue';

const BOTH = { inlineMedia: true, linkPreviews: true };

let posted: string[][];
/** What the fake server does with a batch. Swappable mid-test so a suite can make the
 *  instance fail and then recover, which is the whole shape of the re-ask cases below. */
let respond: (urls: string[]) => unknown;

const okFor = (urls: string[]) => ({
  previews: urls.map((url) => ({
    url,
    status: 'ok',
    kind: 'page',
    title: 'T',
    expiresAt: '2099-01-01T00:00:00Z',
  })),
});

/** What the server sends when it declined to even try — pool saturation, a resolve deadline.
 *  Deliberately NOT cached server-side, and stamped with a seconds-long TTL rather than the
 *  one-hour failure TTL, precisely so a client comes back. See TRANSIENT_TTL_MS. */
const transientFor = (urls: string[]) => ({
  previews: urls.map((url) => ({
    url,
    status: 'unavailable',
    kind: 'page',
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
  })),
});

beforeEach(() => {
  resetLinkPreviewCache();
  posted = [];
  respond = okFor;
  vi.spyOn(apiModule, 'api').mockImplementation(async (_url, opts) => {
    const options = opts ?? {};
    const urls = (options.body as { urls: string[] }).urls;
    posted.push(urls);
    const answer = respond(urls);
    // ⚠ The stub HONOURS `signal`, because `fetch` does and the caller now depends on it. A stub
    // that accepts a signal and ignores it makes a hung request untestable — the promise the
    // caller is waiting on simply never settles, and the timeout it added looks broken.
    if (!options.signal) return answer as never;
    return (await new Promise<unknown>((resolve, reject) => {
      const signal = options.signal!;
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      Promise.resolve(answer).then(resolve, reject);
    })) as never;
  });
});

afterEach(() => vi.restoreAllMocks());

/** Let the coalescing timer fire and the request settle. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('rendering has no side effects', () => {
  it('reading a preview NEVER triggers a request', async () => {
    // ⚠⚠ The architectural invariant. The first version resolved as a side effect of
    // rendering, which meant every scroll into history kicked off fetches that grew rows
    // under the reader — and needed the list to keep correcting its own scroll position.
    // A read must be a read.
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([]);
    expect(entry.value).toBeNull();
  });

  it('priming is what resolves, and a later read sees the result', async () => {
    primePreviews(['look at https://e.test/page'], BOTH);
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([['https://e.test/page']]);
    expect(entry.value?.title).toBe('T');
  });
});

describe('rendering never blocks priming', () => {
  it('a URL that was RENDERED before priming is still primed', async () => {
    // ⚠⚠ Regression guard, and this one shipped broken once: `useLinkPreview` inserts a cache
    // entry as a side effect of being read, and the skip condition was `cache.has(url)` — so a
    // mere render permanently blocked that URL. The failure path was the default one: both
    // settings off → nothing primed → user enables one → rows render and create null entries →
    // no later history page, backlog replay or live message could ever queue them.
    const url = 'https://e.test/rendered-first';
    useLinkPreview(url); // a row renders and reads it
    await settle();
    expect(posted).toEqual([]);

    primePreviews([`look at ${url}`], BOTH);
    await settle();
    expect(posted).toEqual([[url]]);
  });
});

describe('primePreviews', () => {
  it('coalesces a whole batch into one request', async () => {
    // A history page arrives as one batch; it must not become one POST per row.
    primePreviews(['https://e.test/a', 'https://e.test/b', 'https://e.test/c'], BOTH);
    await settle();
    expect(posted.length).toBe(1);
    expect(posted[0]).toHaveLength(3);
  });

  it('asks about a repeated link once across the whole batch', async () => {
    primePreviews(['see https://e.test/x', 'also https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([['https://e.test/x']]);
  });

  it('does not re-ask for something already known', async () => {
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    posted = [];
    // An overlapping history page, or a re-render, must be free.
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });

  it('does nothing at all when both settings are off', async () => {
    primePreviews(['https://e.test/a https://e.test/b.png'], {
      inlineMedia: false,
      linkPreviews: false,
    });
    await settle();
    expect(posted).toEqual([]);
  });

  it('splits a batch past the server cap across requests', async () => {
    primePreviews(
      Array.from({ length: 25 }, (_, i) => `https://e.test/${i}`),
      BOTH,
    );
    await settle();
    expect(posted.length).toBe(2);
    expect(posted[0]).toHaveLength(20);
    expect(posted[1]).toHaveLength(5);
  });

  it('tolerates null and empty bodies', async () => {
    primePreviews([null, undefined, ''], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });
});

describe('re-asking after expiresAt', () => {
  // ⚠⚠ The server splits `unavailable` into a VERDICT (cached, one-hour TTL) and a TRANSIENT
  // refusal (not cached at all, ~15s TTL) — and that split buys nothing unless a client comes
  // back when the short TTL lapses. It didn't: `dropIfExpired` runs only inside `primePreviews`,
  // which is driven by message ingest, and a message already in the store is never ingested
  // again. So a saturated instance blanked a preview for the life of the tab.
  //
  // Fake timers because the shortest honest wait here is the server's own 15 seconds.
  beforeEach(() => {
    vi.useFakeTimers();
    // The backoff is jittered ±25% on purpose (see `jitter`), which makes every deadline in
    // these tests a range. Pinned to the midpoint so the timing assertions can be exact; the
    // jitter itself is asserted separately below, where the randomness is the subject.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => vi.useRealTimers());

  /** Let the coalescing timer fire and the request settle, under fake timers. */
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('re-asks a transient unavailable once its expiresAt has passed, and recovers', async () => {
    respond = transientFor;
    primePreviews(['https://e.test/t'], BOTH);
    await tick(60);
    expect(posted).toEqual([['https://e.test/t']]);

    const entry = useLinkPreview('https://e.test/t');
    expect(entry.value?.status).toBe('unavailable');

    // Nothing should move before the server's own deadline.
    await tick(10_000);
    expect(posted).toHaveLength(1);

    respond = okFor; // the instance stops being saturated
    await tick(10_000);
    expect(posted).toHaveLength(2);
    expect(entry.value?.status).toBe('ok');
    expect(entry.value?.title).toBe('T');
  });

  it('never re-asks a resolved preview, even one with a short TTL', async () => {
    // ⚠ The short TTL is the point. With the 7-day one this assertion would hold whether or not
    // `ok` answers are excluded from the re-ask — it would be a test of the fixture, not of the
    // module. A card that has ALREADY rendered must not become a standing poll when its TTL
    // lapses: the proxy tokens in `src`/`thumb` are an HMAC over the URL and never expire, so
    // there is nothing to refresh. `dropIfExpired` still re-asks on the next ingest.
    respond = (urls) => ({
      previews: urls.map((url) => ({
        url,
        status: 'ok',
        kind: 'page',
        title: 'T',
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
      })),
    });
    primePreviews(['https://e.test/ok'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    await tick(10 * 60_000);
    expect(posted).toHaveLength(1);
  });

  it('keeps a re-ask armed when the re-ask itself fails in transport', async () => {
    // `runReask` disarms a URL as it queues it, expecting the ANSWER to re-arm it. A dropped
    // connection is not an answer — so without the transport-failure branch the first blip
    // during a re-ask retires that URL permanently, which is the bug all over again.
    respond = transientFor;
    primePreviews(['https://e.test/blip'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    respond = () => {
      throw new Error('offline');
    };
    await tick(20_000);
    expect(posted).toHaveLength(2); // the re-ask went out, and died

    respond = okFor;
    await tick(5 * 60_000);
    expect(posted).toHaveLength(3);
    expect(useLinkPreview('https://e.test/blip').value?.status).toBe('ok');
  });

  it('backs off rather than re-asking every 15s at the server-suggested rate', async () => {
    // The floor doubles per consecutive failure. Without it a saturated instance is re-asked
    // every 15 seconds by every open tab, for as long as the tabs stay open — a client
    // hammering exactly the server that just told it that it was overloaded.
    respond = transientFor;
    primePreviews(['https://e.test/sat'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    await tick(16_000); // 1st re-ask, ~15s
    expect(posted).toHaveLength(2);
    await tick(16_000); // 2nd would be here at a flat rate; the floor is now 30s
    expect(posted).toHaveLength(2);
    await tick(16_000);
    expect(posted).toHaveLength(3);
  });

  it('treats a one-hour verdict as an answer, not as something to come back for', async () => {
    // ⚠⚠ The distinction the whole re-ask depends on. The server answers a genuine failure with
    // FAIL_TTL_MS (1h) and a transient refusal with ~15s; re-asking both turns every dead link
    // in the scrollback into an hourly outbound fetch for the life of the tab — and one that is
    // guaranteed to miss the server's own cache, because both deadlines start together.
    respond = (urls) => ({
      previews: urls.map((url) => ({
        url,
        status: 'unavailable',
        kind: 'page',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      })),
    });
    primePreviews(['https://e.test/dead'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    await tick(3 * 60 * 60_000); // three hours
    expect(posted).toHaveLength(1);
  });

  it('jitters the re-ask so simultaneous losers do not return as one wave', async () => {
    // The server jitters its transient TTL precisely so that everything refused by one
    // saturation event doesn't come back together. Taking `max(untilExpiry, floor)` against a
    // FIXED floor threw that away and re-synchronised every client onto the same millisecond —
    // a thundering herd aimed at a server that has just reported itself overloaded.
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => (n++ === 0 ? 0 : 1)); // 0.75x, then 1.25x
    respond = transientFor;
    primePreviews(['https://e.test/a https://e.test/b'], BOTH);
    await tick(60);
    expect(posted).toEqual([['https://e.test/a', 'https://e.test/b']]);

    // Answered together, they must not come BACK together: 11.25s and 18.75s.
    await tick(12_000);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(['https://e.test/a']);
    await tick(8_000);
    expect(posted).toHaveLength(3);
    expect(posted[2]).toEqual(['https://e.test/b']);
  });

  it('recovers a row whose batch failed, without orphaning the ref it is watching', async () => {
    // ⚠⚠ Components capture the Ref OBJECT, not the URL, so deleting a cache entry and minting
    // a fresh one on the next ask delivers the answer into an object nothing is watching. The
    // symptom is the nastiest kind: a fresh read reports `ok` while the row on screen stays
    // blank forever, so the cache looks correct from every angle except the one that matters.
    const held = useLinkPreview('https://e.test/held'); // a mounted row takes its ref
    respond = () => {
      throw new Error('offline');
    };
    primePreviews(['https://e.test/held'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);
    expect(held.value).toBeNull();

    respond = okFor;
    await tick(20_000);
    expect(posted).toHaveLength(2);
    // The SAME ref the row is watching must be the one that resolved.
    expect(held.value?.status).toBe('ok');
    expect(useLinkPreview('https://e.test/held')).toBe(held);
  });

  it('re-asks a URL the server silently omitted from an otherwise-fine response', async () => {
    // No error, no verdict, no retry entry, and `asked` still holding it — a URL dropped from
    // the response reached a state every recovery path stepped over. `?? []` on a malformed 200
    // does the same thing to a whole batch at once.
    respond = () => ({ previews: [] });
    primePreviews(['https://e.test/ghost'], BOTH);
    await tick(60);
    expect(posted).toHaveLength(1);

    respond = okFor;
    await tick(20_000);
    expect(posted).toHaveLength(2);
    expect(useLinkPreview('https://e.test/ghost').value?.status).toBe('ok');
  });
});

describe('cache eviction keeps ref identity (#694)', () => {
  const BOUND = 2000; // MAX_CACHE_ENTRIES

  /** Fill the cache with resolved values, then prime once more to make eviction run.
   *  ⚠ Two steps, deliberately: `evictIfNeeded` runs INSIDE `primePreviews`, before that batch's
   *  answers have come back, so the prime that overflows the ceiling is never the prime that
   *  reclaims. A test that floods and asserts in one step sees nothing evicted. */
  async function floodPastCeiling(
    count: number,
    trigger = 'https://e.test/trigger',
  ): Promise<void> {
    const flood = Array.from({ length: count }, (_, i) => `https://e.test/flood-${i}`);
    primePreviews(
      flood.map((u) => `x ${u}`),
      BOTH,
    );
    await settle();
    primePreviews([trigger], BOTH);
    await settle();
  }

  it('refills the ref a mounted row is holding, rather than minting a fresh one', async () => {
    // ⚠⚠ The trap this test exists to avoid: asserting that a FRESH `useLinkPreview()` read comes
    // back correct passes against the bug, because the fresh read gets the new object. The row on
    // screen is holding the old one. So the ref is captured ONCE, up front, and every assertion
    // below is made through that captured object — which is what MessageAttachments does.
    const victim = 'https://e.test/victim';
    primePreviews([`see ${victim}`], BOTH);
    const held = useLinkPreview(victim); // the mounted row captures the Ref OBJECT
    await settle();
    expect(held.value?.title).toBe('T');

    await floodPastCeiling(BOUND + 100);

    // Identity survived: the row is still watching the object the cache holds.
    expect(useLinkPreview(victim)).toBe(held);
    // Its value was reclaimed — that is the eviction.
    expect(held.value).toBeNull();

    // And a re-prime delivers into THAT object. Under the bug the answer landed in a fresh ref
    // and this stayed null for the life of the tab.
    primePreviews([`see ${victim} again`], BOTH);
    await settle();
    expect(held.value?.title).toBe('T');
  });

  it('binds the ceiling as soon as the answers land, not on the next prime', async () => {
    // `heldValues` only grows in `flush`, so eviction driven solely from `primePreviews` left one
    // large ingest — a history page, or switching previews on over a loaded buffer — sitting
    // above the ceiling until some later message happened to prime again. No second prime here.
    const held: Array<ReturnType<typeof useLinkPreview>> = [];
    const urls = Array.from({ length: BOUND + 300 }, (_, i) => `https://e.test/single-${i}`);
    primePreviews(
      urls.map((u) => `x ${u}`),
      BOTH,
    );
    for (const u of urls) held.push(useLinkPreview(u));
    await settle();

    expect(held.filter((r) => r.value != null).length).toBeLessThanOrEqual(BOUND);
  });

  it('still bounds the number of resolved values', async () => {
    // The ceiling has to keep doing its job — the fix must not become "never reclaim anything".
    const held: Array<ReturnType<typeof useLinkPreview>> = [];
    const urls = Array.from({ length: BOUND + 200 }, (_, i) => `https://e.test/bounded-${i}`);
    primePreviews(
      urls.map((u) => `x ${u}`),
      BOTH,
    );
    for (const u of urls) held.push(useLinkPreview(u));
    await settle();

    primePreviews(['https://e.test/bounded-trigger'], BOTH);
    await settle();

    const stillHeld = held.filter((r) => r.value != null).length;
    expect(stillHeld).toBeLessThanOrEqual(BOUND);
    // Oldest-first: the reclaimed ones are at the front.
    expect(held[0].value).toBeNull();
    expect(held.at(-1)!.value).not.toBeNull();
  });

  it('re-pins the anchor when eviction blanks a card', async () => {
    // Nulling a value changes a row's height, so it owes `previewRevision` a bump.
    //
    // ⚠ Isolating that bump takes care: an ARRIVING ANSWER bumps `previewRevision` too
    // (unconditionally, see `flush`), so a trigger that fetches anything cannot tell the two
    // apart. The trigger here is a URL already in `asked`, so `primePreviews` skips it — nothing
    // is queued, no flush runs, and the only thing left that can move the counter is eviction.
    const settled = 'https://e.test/already-answered';
    primePreviews([settled], BOTH);
    await settle();

    const quiet = previewRevision.value;
    primePreviews([settled], BOTH); // same URL again: no queue, no answer, no eviction yet
    await settle();
    expect(previewRevision.value).toBe(quiet);

    await floodPastCeiling(BOUND + 100, settled);
    expect(previewRevision.value).toBeGreaterThan(quiet);
  });
});

describe('is an answer still coming?', () => {
  // ⚠⚠ The distinction the reveal gate in `MessageAttachments` rests on. That component holds a
  // message's whole attachment block back until every URL in it has settled, so it has to tell
  // "in flight" apart from "nobody ever asked" — and only this module knows. Its own suite mocks
  // `usePreviewsSettled`, so this is the ONLY place the real rule is exercised.
  //
  // The gate's first version guessed with a 1500ms timer instead. The guess was wrong by more
  // than an order of magnitude (the server allows 10s of queue wait plus a 30s resolve deadline
  // per URL, answered as one `Promise.all` over the slice), so it fired on any cold link and
  // revealed a partial set — re-creating the very arrangement flip it existed to prevent.

  const urls = (...list: string[]) => ref(list);

  it('says NOT SETTLED while a primed URL is still in flight', async () => {
    let release: (() => void) | undefined;
    respond = (list) =>
      new Promise((resolve) => {
        release = () => resolve(okFor(list));
      });

    const settledRef = usePreviewsSettled(urls('https://e.test/slow'));
    primePreviews(['https://e.test/slow'], BOTH);
    await settle();
    expect(settledRef.value).toBe(false);

    release?.();
    await settle();
    expect(settledRef.value).toBe(true);
  });

  it('says SETTLED for a URL nobody ever primed', () => {
    // ⚠ The property that makes the gate safe. `useLinkPreview` hands back a permanently-null ref
    // for an unprimed URL, so a gate of "every entry has a value" would blank that message for
    // the life of the tab. Not in flight means not coming, so render now.
    expect(usePreviewsSettled(urls('https://e.test/never-primed')).value).toBe(true);
  });

  it('says SETTLED when a transport failure puts a URL back in play, with no value to show', async () => {
    // ⚠⚠ THE FAIL-OPEN CASE, and the one the gate got wrong. `forgetForRetry` runs for every URL
    // in a slice whose POST threw and for every URL the server omitted from a 200 — leaving a
    // null value AND a `retry` entry. Counting that as pending hid the whole message's attachment
    // block, cached siblings included, for the entire 15s→5min ladder and indefinitely while the
    // server kept failing: one 502 during a deploy blanked every message sharing its batch.
    //
    // ⚠ This is also the ONLY test that can observe `usePreviewsSettled`'s `pendingRevision` read.
    // Every other transition in this file moves an entry ref too, and a ref read makes the
    // computed reactive by itself. Here the ref is null before and null after — only the pending
    // set moves — so a SUBSCRIBED computed (which is what the component's `watch` creates) never
    // re-evaluates without that line.
    respond = () => {
      throw new Error('502');
    };
    const settledRef = usePreviewsSettled(urls('https://e.test/broken'));

    // ⚠ Subscribe AFTER priming, so the first value observed is `false`. Subscribing before means
    // the immediate call records `true` (nothing is pending yet), the assertion at the end reads
    // `true` whatever happened in between, and the test passes against every mutation.
    primePreviews(['https://e.test/broken'], BOTH);
    const seen: boolean[] = [];
    watch(settledRef, (v) => seen.push(v), { immediate: true });
    expect(seen).toEqual([false]);

    await settle();

    expect(useLinkPreview('https://e.test/broken').value).toBeNull();
    expect(seen.at(-1)).toBe(true);
  });

  it('says SETTLED for a failure awaiting a re-ask, rather than holding the message', async () => {
    // A transient refusal has an ANSWER; the re-ask may be minutes out. Treating a queued re-ask
    // as pending would hide a whole message on the strength of one saturated fetch.
    respond = transientFor;
    const settledRef = usePreviewsSettled(urls('https://e.test/transient'));
    primePreviews(['https://e.test/transient'], BOTH);
    await settle();
    expect(useLinkPreview('https://e.test/transient').value?.status).toBe('unavailable');
    expect(settledRef.value).toBe(true);
  });
});

describe('the re-pin signal', () => {
  // ⚠⚠ `previewRevision` is what MessageList watches to re-anchor a scrolled-up reader, and until
  // now NOTHING in the repo asserted it — the branch's headline change to it could be reverted
  // with a fully green suite. Every path that moves a URL out of the pending set can open a
  // reveal gate, and every gate that opens grows a row, so every such path has to bump it.

  it('bumps for a batch that answers with no `ok` at all', async () => {
    // The old condition was `if (changed)` — some answer was `ok`. With the gate, an
    // `unavailable` is very often the answer that COMPLETES a message's gate and paints its whole
    // block, so an all-unavailable batch is exactly when a re-pin is needed.
    respond = transientFor;
    const before = previewRevision.value;
    primePreviews(['https://e.test/dead'], BOTH);
    await settle();
    expect(previewRevision.value).toBeGreaterThan(before);
  });

  it('bumps when the request fails and the gate falls open', async () => {
    // The largest single growth this feature produces: a 502 mid-deploy fails every URL in the
    // slice open at once, painting every block that was waiting on it — cached siblings included.
    respond = () => {
      throw new Error('502');
    };
    const before = previewRevision.value;
    primePreviews(['https://e.test/boom'], BOTH);
    await settle();
    expect(previewRevision.value).toBeGreaterThan(before);
  });

  it('does NOT bump when eviction only drops URLs that had already settled', async () => {
    // ⚠⚠ Once a long-lived tab saturates the cache, `while (size > MAX)` trims to exactly the
    // ceiling — so EVERY prime that creates an entry evicts one. Reporting that as a layout event
    // fired a re-pin (two forced synchronous layouts over an unvirtualised 500-row list) on
    // essentially every incoming message, compensating for a growth that had not happened. Only
    // an evicted URL something was still WAITING on can change what renders.
    //
    // Entries are created by reading, not by priming: `useLinkPreview` calls `entryFor` without
    // touching `asked`, so these are settled from birth and eviction cannot open a gate.
    for (let n = 0; n <= 2000; n++) useLinkPreview(`https://e.test/fill/${n}`);
    respond = okFor;
    const before = previewRevision.value;

    primePreviews(['https://e.test/evictor'], BOTH);

    expect(previewRevision.value).toBe(before);
  });

  it('does NOT bump merely for queueing work', async () => {
    // Priming only ever ADDS to the pending set, so it can close a gate but never open one. A
    // bump here would re-pin the list on every incoming line of chat.
    respond = okFor;
    primePreviews(['https://e.test/one'], BOTH);
    await settle();
    const before = previewRevision.value;
    primePreviews(['https://e.test/two'], BOTH);
    expect(previewRevision.value).toBe(before);
  });
});

describe('a re-ask that is in flight', () => {
  // ⚠⚠ The ordering case in `previewPending`, and the one its docblock calls load-bearing.
  // `runReask` does `retry.set(url, {at: Infinity})` AND `queue.add(url)` on a URL whose value is
  // still null — so if `queue`/`asked` were tested first, a recovery ATTEMPT would report the URL
  // pending and re-hide a block that is already on screen. A shrink, caused by trying to help.
  //
  // Nothing else reaches it. The neighbouring tests either carry a value (which short-circuits
  // before the clause) or run after `forgetForRetry` has emptied `asked`, so `queue || asked` is
  // false whatever the order. Deleting the clause, or moving it after those two, left 61/61 green.
  beforeEach(() => {
    vi.useFakeTimers();
    // Pins the ±25% backoff jitter to its midpoint, so the re-ask lands at exactly the 15s floor
    // and the assertion can sit inside the 24ms window before the flush drains `queue`.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => vi.useRealTimers());

  it('stays SETTLED while its re-ask is queued and in flight', async () => {
    respond = () => {
      throw new Error('502');
    };
    const settledRef = usePreviewsSettled(ref(['https://e.test/reasked']));
    primePreviews(['https://e.test/reasked'], BOTH);
    await vi.advanceTimersByTimeAsync(60);
    expect(settledRef.value).toBe(true);

    // Hang the retry, and stop the clock the instant `runReask` has re-queued it — before the
    // 24ms coalescing timer drains `queue` again. This is the only window in which the URL is in
    // `retry` AND `queue` with a null value, which is precisely the state the clause is about.
    respond = () => new Promise(() => {});
    await vi.advanceTimersByTimeAsync(15_000);

    expect(settledRef.value).toBe(true);
  });
});

describe('a resolve that never answers', () => {
  // ⚠⚠ `api()` is a bare `fetch` with no signal and no timeout, so a dead NAT mapping or a proxy
  // that accepts and never replies leaves the promise pending forever — and `flush` awaits its
  // slices sequentially, so one hung POST also strands every later slice. Before the reveal gate
  // that cost a missing card; with it, every message holding one of those URLs renders NO
  // attachments, permanently. A gate that must fail open cannot be built on a request that never
  // settles.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('gives up on a hung request and reports the URL settled', async () => {
    respond = () => new Promise(() => {});
    const settledRef = usePreviewsSettled(ref(['https://e.test/hung']));
    primePreviews(['https://e.test/hung'], BOTH);
    const seen: boolean[] = [];
    watch(settledRef, (v) => seen.push(v), { immediate: true });

    await tick(60);
    expect(seen.at(-1)).toBe(false);

    // Past RESOLVE_TIMEOUT_MS. The URL goes back in play through the same `forgetForRetry` path a
    // transport error takes, which is what makes it settled rather than merely un-asked.
    await tick(46_000);

    expect(seen.at(-1)).toBe(true);
  });
});
