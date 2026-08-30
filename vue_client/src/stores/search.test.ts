// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The search store over GET /api/search (#676): the dedupe that keeps no-op
// input changes (trailing space, half-typed filter token) from blanking and
// refetching, plus the token/abort machinery that keeps slow responses from
// clobbering a newer query's results.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const api = vi.fn<(url: string, opts?: { signal?: AbortSignal }) => Promise<any>>();
vi.mock('../api.js', () => ({
  api: (url: string, opts?: { signal?: AbortSignal }) => api(url, opts),
}));

const { useSearchStore } = await import('./search.js');

beforeEach(() => {
  setActivePinia(createPinia());
  api.mockReset();
  api.mockResolvedValue({ items: [{ id: 3 }], nextBefore: null });
});

describe('runSearch over REST', () => {
  it('dispatches GET /api/search with the parsed filters', async () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos in:#dev fart');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(1);
    const url = api.mock.calls[0][0];
    expect(url).toContain('/api/search?');
    expect(url).toContain('q=fart');
    expect(url).toContain('nick=amiantos');
    expect(url).toContain('target=%23dev');
    expect(store.results).toEqual([{ id: 3 }]);
    expect(store.hasMore).toBe(false);
    expect(store.searched).toBe(true);
  });

  it('skips a re-dispatch when the effective query is unchanged', async () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos fart');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(1);

    // Trailing space parses to the same URL — keep the results, no request.
    store.setQuery('from:amiantos fart ');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.results).toEqual([{ id: 3 }]);
    expect(store.loading).toBe(false);
  });

  it('dispatches again when the effective query changes', async () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos far');
    await store.runSearch();
    store.setQuery('from:amiantos fart');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a superseded response never lands, and the older request is aborted', async () => {
    const store = useSearchStore();
    let resolveFirst!: (v: unknown) => void;
    const firstSignal: { signal?: AbortSignal } = {};
    api.mockImplementationOnce((_url, opts) => {
      firstSignal.signal = opts?.signal;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });

    store.setQuery('slow query');
    const first = store.runSearch();
    store.setQuery('fast query');
    await store.runSearch();
    expect(store.results).toEqual([{ id: 3 }]);
    expect(firstSignal.signal?.aborted).toBe(true);

    // The slow reply resolves late — it must not clobber the newer results.
    resolveFirst({ items: [{ id: 999 }], nextBefore: null });
    await first;
    expect(store.results).toEqual([{ id: 3 }]);
  });

  it('retries an identical query after a failed dispatch', async () => {
    const store = useSearchStore();
    api.mockRejectedValueOnce(new Error('offline'));
    store.setQuery('from:amiantos');
    await store.runSearch();
    expect(store.error).toBe('offline');

    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(2);
    expect(store.error).toBe('');
  });

  it('re-dispatches a query retyped after clearing to empty', async () => {
    const store = useSearchStore();
    store.setQuery('from:amiantos');
    await store.runSearch();

    store.setQuery('');
    await store.runSearch(); // nothing to search — clears the session
    expect(store.searched).toBe(false);
    expect(store.results).toEqual([]);

    store.setQuery('from:amiantos');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('loadMore appends the next page via the nextBefore cursor', async () => {
    const store = useSearchStore();
    api.mockResolvedValueOnce({ items: [{ id: 9 }, { id: 8 }], nextBefore: 8 });
    store.setQuery('paged');
    await store.runSearch();
    expect(store.hasMore).toBe(true);

    api.mockResolvedValueOnce({ items: [{ id: 7 }], nextBefore: null });
    await store.loadMore();
    expect(api.mock.calls[1][0]).toContain('before=8');
    expect(store.results.map((r) => r.id)).toEqual([9, 8, 7]);
    expect(store.hasMore).toBe(false);
  });

  it('a successful loadMore retry clears the previous pagination error', async () => {
    const store = useSearchStore();
    api.mockResolvedValueOnce({ items: [{ id: 9 }], nextBefore: 9 });
    store.setQuery('flaky page');
    await store.runSearch();

    api.mockRejectedValueOnce(new Error('offline'));
    await store.loadMore();
    expect(store.error).toBe('offline');
    expect(store.hasMore).toBe(true); // cursor survives the failure — retry is possible

    api.mockResolvedValueOnce({ items: [{ id: 8 }], nextBefore: null });
    await store.loadMore();
    expect(store.error).toBe('');
    expect(store.results.map((r) => r.id)).toEqual([9, 8]);
  });

  it('reset clears the dedupe key', async () => {
    const store = useSearchStore();
    store.setQuery('hello');
    await store.runSearch();
    store.reset();
    store.setQuery('hello');
    await store.runSearch();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
