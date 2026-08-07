// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// #693: the preview re-prime watcher is created from inside `useSocket`'s `onMounted`, so it was
// registered in the CALLING COMPONENT's effect scope and stopped when that component unmounted —
// and the module-level `previewTogglesWired` latch then guaranteed it was never rebuilt. The
// route that mounts first owns it; opening Settings destroys it.
//
// ⚠⚠ Every test here UNMOUNTS the owning component before flipping the toggle. Asserting that the
// watcher fires while the first component is still mounted passes against the bug.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

// `vi.hoisted`, because the `vi.mock` factory below is hoisted above ordinary top-level consts.
const { primePreviews } = vi.hoisted(() => ({
  primePreviews: vi.fn<(texts: unknown[], toggles: unknown) => void>(),
}));
vi.mock('./useLinkPreview.js', () => ({
  primePreviews,
  // `useSocket` imports the module, so anything else it pulls in must exist.
  previewRevision: { value: 0 },
}));

// `open()` runs in the same onMounted; a fake keeps it from reaching the network.
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  close(): void {}
  send(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

import { useSocket, resetPreviewToggleWiring } from './useSocket.js';
import { useConfigStore } from '../stores/config.js';
import { useSettingsStore } from '../stores/settings.js';
import { useBuffersStore } from '../stores/buffers.js';

/** A route component, standing in for DesktopChat / Settings. */
const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

function seed({ inlineMedia = false, linkPreviews = false } = {}) {
  setActivePinia(createPinia());
  useConfigStore().features = { linkPreviews: true };
  const settings = useSettingsStore();
  settings.values = {
    'chat.inline_media.enabled': inlineMedia,
    'chat.link_previews.enabled': linkPreviews,
  };
  settings.loaded = true;
  // One loaded buffer with a message, so a re-prime has something to prime.
  const buffers = useBuffersStore();
  buffers.buffers = {
    'n1:#chan': {
      networkId: 1,
      target: '#chan',
      messages: [{ id: 1, type: 'message', text: 'see https://e.test/x', target: '#chan' }],
    },
  } as unknown as typeof buffers.buffers;
  return settings;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  primePreviews.mockClear();
  resetPreviewToggleWiring();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPreviewToggleWiring();
});

describe('preview toggle re-prime survives a route change (#693)', () => {
  it('still fires after the component that wired it has unmounted', async () => {
    const settings = seed();

    // 1. Load '/': the chat view mounts and calls useSocket().
    const chat = mount(RouteView);
    await nextTick();

    // 2. Navigate to '/settings': the chat view is destroyed. No KeepAlive anywhere in the app,
    //    so this is a real teardown, not a deactivation.
    chat.unmount();
    await nextTick();
    primePreviews.mockClear();

    // 3. The user switches link previews on, from the Settings route.
    settings.values = { ...settings.values, 'chat.link_previews.enabled': true };
    await nextTick();

    // Under the bug: the watcher died with the chat view, the latch blocked a rebuild, and
    // nothing primed — every existing message stayed without a preview until a full reload.
    expect(primePreviews).toHaveBeenCalled();
  });

  it('fires for a second route that calls useSocket() after the first is gone', async () => {
    const settings = seed();

    const chat = mount(RouteView);
    await nextTick();
    chat.unmount();
    await nextTick();

    // The Settings route calls useSocket() too — and hits the wired-once latch.
    const settingsView = mount(RouteView);
    await nextTick();
    primePreviews.mockClear();

    settings.values = { ...settings.values, 'chat.inline_media.enabled': true };
    await nextTick();

    expect(primePreviews).toHaveBeenCalled();
    settingsView.unmount();
  });

  it('primes every loaded buffer, not just the one on screen', async () => {
    const settings = seed();
    const buffers = useBuffersStore();
    buffers.buffers = {
      'n1:#a': {
        networkId: 1,
        target: '#a',
        messages: [{ id: 1, type: 'message', text: 'https://e.test/a', target: '#a' }],
      },
      'n1:#b': {
        networkId: 1,
        target: '#b',
        messages: [{ id: 2, type: 'message', text: 'https://e.test/b', target: '#b' }],
      },
    } as unknown as typeof buffers.buffers;

    const chat = mount(RouteView);
    await nextTick();
    chat.unmount();
    await nextTick();
    primePreviews.mockClear();

    settings.values = { ...settings.values, 'chat.link_previews.enabled': true };
    await nextTick();

    expect(primePreviews).toHaveBeenCalledTimes(2);
  });

  it('does not re-prime when a setting is switched OFF', async () => {
    const settings = seed({ linkPreviews: true });

    const chat = mount(RouteView);
    await nextTick();
    chat.unmount();
    await nextTick();
    primePreviews.mockClear();

    settings.values = { ...settings.values, 'chat.link_previews.enabled': false };
    await nextTick();

    // Turning one off needs no work — the rows simply stop rendering.
    expect(primePreviews).not.toHaveBeenCalled();
  });
});
