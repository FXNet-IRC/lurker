// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

let setAppBadge: Mock<(count?: number) => Promise<void>>;
let clearAppBadge: Mock<() => Promise<void>>;

beforeEach(() => {
  // Reset the module registry so each test gets a fresh useAppBadge with a fresh
  // module-level effect scope — no cross-test ordering dependency.
  vi.resetModules();
  setAppBadge = vi.fn<(count?: number) => Promise<void>>(() => Promise.resolve());
  clearAppBadge = vi.fn<() => Promise<void>>(() => Promise.resolve());
});

afterEach(() => vi.unstubAllGlobals());

// Load a fresh useAppBadge wired to a ref we control. `vue` is imported AFTER the
// module reset and the ref is created from that same fresh instance, so the
// composable's `watch` (which imports the same post-reset `vue`) tracks it — a
// statically-imported ref would belong to a different reactivity instance and
// never trigger the watcher. `supported:false` models a browser without the API.
async function load(supported = true) {
  const { ref, nextTick } = await import('vue');
  const total = ref(0);
  vi.doMock('../stores/buffers.js', () => ({
    useBuffersStore: () => ({
      get totalHighlights() {
        return total.value;
      },
    }),
  }));
  vi.stubGlobal('navigator', supported ? { setAppBadge, clearAppBadge } : {});
  const mod = await import('./useAppBadge.js');
  return { ...mod, total, nextTick };
}

describe('useAppBadge', () => {
  it('wires a watcher that sets the badge to the highlight total and clears at zero', async () => {
    const { startAppBadge, total, nextTick } = await load();
    startAppBadge();
    // immediate:true fires at the current total (0) → clear, not set.
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();

    total.value = 3;
    await nextTick();
    expect(setAppBadge).toHaveBeenLastCalledWith(3);

    total.value = 0;
    await nextTick();
    expect(clearAppBadge).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — repeated startAppBadge calls add only one watcher', async () => {
    const { startAppBadge, total, nextTick } = await load();
    startAppBadge();
    startAppBadge();
    startAppBadge();
    setAppBadge.mockClear(); // ignore the immediate fire from wiring
    total.value = 7;
    await nextTick();
    // Exactly one watcher → exactly one setAppBadge for the single change.
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
  });

  it('clearAppBadgeNow clears the badge', async () => {
    const { clearAppBadgeNow } = await load();
    clearAppBadgeNow();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('no-ops when the Badging API is unavailable', async () => {
    const { startAppBadge, clearAppBadgeNow, total, nextTick } = await load(false);
    startAppBadge();
    clearAppBadgeNow();
    total.value = 5;
    await nextTick();
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
