// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMessageActions, type MessageContext, type MessageLike } from './useMessageActions.js';
import { useContextMenu } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useBuffersStore } from '../stores/buffers.js';

function makeCtx(): MessageContext {
  return {
    networkId: 1,
    onReply: vi.fn<(message: MessageLike) => void>(),
    onIgnore: vi.fn<(message: MessageLike) => void>(),
  };
}

// A message from someone else, with text and a stable id — the case that yields
// the full action set. Override individual fields per case.
function other(over: Partial<MessageLike> = {}): MessageLike {
  return { id: 42, networkId: 1, nick: 'bob', text: 'hi', self: false, ...over };
}

describe('useMessageActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The context menu is a module-level singleton — reset between cases.
    useContextMenu().close();
  });

  describe('buildActions', () => {
    it('returns reply, copy, save, ignore for another user with text + id', () => {
      const actions = useMessageActions().buildActions(other());
      expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'save', 'ignore']);
    });

    it('drops reply + ignore on your own line', () => {
      const actions = useMessageActions().buildActions(other({ self: true }));
      expect(actions.map((a) => a.key)).toEqual(['copy', 'save']);
    });

    it('drops copy when there is no text', () => {
      const actions = useMessageActions().buildActions(other({ text: '' }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'save', 'ignore']);
    });

    it('drops save when there is no stable id', () => {
      const actions = useMessageActions().buildActions(other({ id: null }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'ignore']);
    });

    it('drops save on a system-buffer line, which has no owning network', () => {
      // networkId null == the app-scoped system buffer. The server can't save
      // these (the ownership check joins through networks), so offering it
      // would be a button that silently does nothing.
      const actions = useMessageActions().buildActions(other({ networkId: null }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'ignore']);
    });

    it('does not label a system line saved when a real message shares its id', () => {
      // System lines have their own id sequence, so #42 here is NOT the #42 the
      // user bookmarked in a channel.
      useBookmarksStore().noteFromEvents([{ id: 42, bookmarked: true }], 1);
      const actions = useMessageActions().buildActions(other({ networkId: null }));
      expect(actions.find((a) => a.key === 'save')).toBeUndefined();
    });

    it('reflects a saved bookmark in the save label, icon, and active flag', () => {
      // Seeded the way production seeds it: off the `bookmarked` flag riding on
      // a message row, not a connect-burst snapshot.
      useBookmarksStore().noteFromEvents([{ id: 42, bookmarked: true }], 1);
      const save = useMessageActions()
        .buildActions(other())
        .find((a) => a.key === 'save');
      expect(save?.label).toBe('Remove bookmark');
      expect(save?.icon).toBe('fa-solid fa-bookmark');
      expect(save?.active).toBe(true);
    });

    it('returns nothing for a null message', () => {
      expect(useMessageActions().buildActions(null)).toEqual([]);
    });
  });

  describe('buildItems parity', () => {
    it('matches buildActions label + icon, in the same order', () => {
      const api = useMessageActions();
      const m = other();
      const actions = api.buildActions(m);
      const items = api.buildItems(m, makeCtx());
      expect(items.map((i) => i.label)).toEqual(actions.map((a) => a.label));
      expect(items.map((i) => i.icon)).toEqual(actions.map((a) => a.icon));
    });

    it('reply item dispatches onReply through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const reply = api.buildItems(m, ctx).find((i) => i.icon?.includes('fa-reply'));
      reply?.onClick?.();
      expect(ctx.onReply).toHaveBeenCalledWith(m);
    });

    it('ignore item dispatches onIgnore through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const ignore = api.buildItems(m, ctx).find((i) => i.icon?.includes('fa-ban'));
      ignore?.onClick?.();
      expect(ctx.onIgnore).toHaveBeenCalledWith(m);
    });

    it('save item toggles the bookmark store through run()', () => {
      const api = useMessageActions();
      const toggle = vi.spyOn(useBookmarksStore(), 'toggle');
      const m = other();
      const save = api.buildItems(m, makeCtx()).find((i) => i.icon?.includes('fa-bookmark'));
      save?.onClick?.();
      expect(toggle).toHaveBeenCalledWith(m);
    });
  });

  describe('openMenu', () => {
    it('opens the shared context menu with the items at the given point', () => {
      const api = useMessageActions();
      const menu = useContextMenu();
      api.openMenu(other(), makeCtx(), 12, 34);
      expect(menu.state.open).toBe(true);
      expect(menu.state.x).toBe(12);
      expect(menu.state.y).toBe(34);
      expect(menu.state.items.length).toBe(4);
    });

    it('no-ops for a null message', () => {
      const api = useMessageActions();
      const menu = useContextMenu();
      api.openMenu(null, makeCtx(), 1, 2);
      expect(menu.state.open).toBe(false);
    });
  });
});

describe('copy link to message (#744)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useContextMenu().close();
  });

  /** A line in a buffer the server has given an id. */
  function inBuffer(target: string, bufferId: number, over: Partial<MessageLike> = {}) {
    useBuffersStore().ensure(1, target, bufferId);
    return other({ target, ...over });
  }

  it('uses the id the row carries, without a store lookup', () => {
    // Server message events ship bufferId, and buildActions runs for every
    // rendered row — so the common path must not go through findByTarget.
    const actions = useMessageActions().buildActions(
      other({ target: '#chan', bufferId: 7 }), // no buffer registered in the store
    );
    expect(actions.map((a) => a.key)).toContain('link');
  });

  it('offers the link once the buffer has a server id', () => {
    const actions = useMessageActions().buildActions(inBuffer('#chan', 7));
    expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'link', 'save', 'ignore']);
  });

  it('copies an absolute /buffer/<id>?msg=<id> URL', async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const msg = inBuffer('#chan', 7);
    useMessageActions().run('link', msg, makeCtx());

    // The id form is the whole point: no `#` to percent-encode, and the channel
    // name never reaches the URL.
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/buffer/7?msg=42`);
    vi.unstubAllGlobals();
  });

  it.each([['#chan'], ['&local'], ['+modeless'], ['!12345chan'], ['alice']])(
    'links %s by id, with no name in the URL',
    (target) => {
      const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      useMessageActions().run('link', inBuffer(target, 7), makeCtx());

      const url = writeText.mock.calls[0][0];
      expect(url).toBe(`${window.location.origin}/buffer/7?msg=42`);
      // All four channel sigils and a DM nick: none of them reach the URL, so
      // there is no encoding path here to get wrong.
      expect(url).not.toContain(target);
      vi.unstubAllGlobals();
    },
  );

  it('drops the link on a system line, which has no buffer route', () => {
    const actions = useMessageActions().buildActions(
      inBuffer('#chan', 7, { networkId: null, target: ':system:' }),
    );
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link in a server console, where a jump is refused anyway', () => {
    // useJumpToMessage bails on `:server:` with "Cannot jump in server buffer",
    // so a link there would open the buffer and then toast instead of scrolling.
    const actions = useMessageActions().buildActions(inBuffer(':server:1', 8));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link while the buffer has no server id yet', () => {
    // An optimistically created buffer — "Send DM" to a never-DM'd nick — has
    // no row id until the server answers, so there is nothing to address.
    useBuffersStore().ensure(1, 'newpal');
    const actions = useMessageActions().buildActions(other({ target: 'newpal' }));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link on a line with no message id', () => {
    const actions = useMessageActions().buildActions(inBuffer('#chan', 7, { id: null }));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('reaches the context menu too, not just the hover bar', () => {
    const labels = useMessageActions()
      .buildItems(inBuffer('#chan', 7), makeCtx())
      .map((i) => i.label);
    expect(labels).toContain('Copy link to message');
  });
});
