// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The store sends verbs over the socket; nothing here needs a real one.
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(),
}));

import { useBookmarksStore } from './bookmarks.js';

// The id set is a cache of what the client has SEEN — there is no bookmark snapshot in
// the connect burst, so it is fed entirely by the `bookmarked` flag riding on message
// rows plus the `bookmark-updated` echo. These are the rules that keep it honest.
describe('bookmarks store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const NET = 1;

  it('seeds the set from the flags on a page of rows', () => {
    const store = useBookmarksStore();
    store.noteFromEvents([{ id: 1 }, { id: 2, bookmarked: true }], NET);
    expect(store.isSaved(2)).toBe(true);
    expect(store.isSaved(1)).toBe(false);
  });

  // A row that arrives WITHOUT the flag is authoritative for itself: the server omits it
  // when false. Without this, an unsave made on another device while this tab was
  // disconnected would never land — the echo was missed, and the reconnect backlog that
  // carries the truth was only ever read for additions.
  it('clears a bookmark when the row comes back unflagged', () => {
    const store = useBookmarksStore();
    store.noteFromEvents([{ id: 2, bookmarked: true }], NET);
    store.noteFromEvents([{ id: 2 }], NET);
    expect(store.isSaved(2)).toBe(false);
  });

  // …but only for the rows it actually contains. A page knows its own slice and no more,
  // so silence about an id is not an unsave — otherwise paging up would unlight every
  // bookmark above the fold.
  it('does not touch ids the page says nothing about', () => {
    const store = useBookmarksStore();
    store.noteFromEvents([{ id: 2, bookmarked: true }], NET);
    store.noteFromEvents([{ id: 9 }], NET);
    expect(store.isSaved(2)).toBe(true);
  });

  // System-buffer rows come from a different table with its own id sequence, overlapping
  // the message ids this set is keyed by. They never carry the flag, so reconciling
  // against them would clear real bookmarks that happen to share an id.
  it('ignores system-buffer pages entirely', () => {
    const store = useBookmarksStore();
    store.noteFromEvents([{ id: 2, bookmarked: true }], NET);
    store.noteFromEvents([{ id: 2 }], null);
    expect(store.isSaved(2)).toBe(true);
  });

  // The list holds fetched ROWS of someone's private conversations, and `ensureLoaded`
  // skips the refetch while it believes them current — so a connect (a new session, or
  // a gap during which another device saved something) has to re-arm it.
  it('markListStale forces the next open to refetch', () => {
    const store = useBookmarksStore();
    store.listDirty = false;
    store.markListStale();
    expect(store.listDirty).toBe(true);
  });

  it('applyUpdate is the echo path, in both directions', () => {
    const store = useBookmarksStore();
    store.applyUpdate({ messageId: 7, saved: true });
    expect(store.isSaved(7)).toBe(true);
    store.applyUpdate({ messageId: 7, saved: false });
    expect(store.isSaved(7)).toBe(false);
  });

  // Unsaving splices the row out of the loaded page so the modal updates without a
  // refetch — the echo carries no row payload to re-add it with.
  it('an unsave echo removes the row from the loaded list', () => {
    const store = useBookmarksStore();
    store.items = [{ id: 7, networkId: NET, target: '#a', nick: 'alice' }];
    store.ids.add(7);
    store.applyUpdate({ messageId: 7, saved: false });
    expect(store.items).toEqual([]);
  });
});
