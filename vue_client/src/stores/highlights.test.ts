// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// loadInitial's skipIfSameFilter contract: the modal's debounced-typing path
// passes true so no-op input changes (trailing space, half-typed filter token)
// don't blank + refetch, while mount-time loads omit it and ALWAYS refetch —
// highlights are a live feed, the same filter can have new rows.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const api = vi.fn<(url: string) => Promise<any>>();
vi.mock('../api.js', () => ({
  api: (url: string) => api(url),
}));

const { useHighlightsStore } = await import('./highlights.js');

beforeEach(() => {
  setActivePinia(createPinia());
  api.mockReset();
  api.mockResolvedValue({ items: [{ id: 1 }], nextBefore: null });
});

describe('loadInitial skipIfSameFilter', () => {
  it('skips a debounced reload when the filter is unchanged', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual([{ id: 1 }]);

    store.setQuery('from:amiantos '); // trailing space — same effective filter
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual([{ id: 1 }]);
  });

  it('reloads when the filter actually changes', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    store.setQuery('from:amiantos deploy');
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a mount-time load always refetches the live feed', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    await store.loadInitial(); // modal reopened — same filter, fresh rows
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('retries an identical filter after an error', async () => {
    const store = useHighlightsStore();
    api.mockRejectedValueOnce(new Error('boom'));
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    expect(store.error).toBe('boom');

    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(store.error).toBe('');
    expect(store.items).toEqual([{ id: 1 }]);
  });
});
