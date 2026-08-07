// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Lives in composables/, not lib/: it leans on Vue's watch, and lib/ is
// documented (AGENTS.md) as framework-free logic. Not a use* composable — it
// needs no component context — but this is the Vue-coupled directory.
import { watch } from 'vue';

// How long to wait for the app to become able to honor a cold-start deep link
// before giving up. networks.fetchAll() (REST) has resolved by the time anyone
// looks, but buffers and the socket come up asynchronously over the WS — and
// loadAround() no-ops while the socket is closed — so the intent is held until
// both land. Shared by every deep-link entry point: the legacy `?net&buf&msg`
// query, the `/buffer/<id>?msg=` route, and the route resolver in
// useBufferRoute, which all wait on the same cold start and would be arbitrary
// to give different budgets.
export const COLD_START_TIMEOUT_MS = 10000;

/**
 * Run `act` as soon as `ready()` first holds, or `onTimeout` if it hasn't held
 * within `timeoutMs`. Fires at most once either way; returns a disposer that
 * cancels whichever is still pending.
 *
 * `ready` must read only REACTIVE state — a getter over a plain Map or a
 * module-level variable tracks nothing, so the watch would never re-fire and
 * every caller would silently fall through to its timeout. (That is not
 * hypothetical: resolving a buffer id through the module-level keyById index
 * instead of the store's reactive `byId` getter did exactly this.)
 */
export function whenReady(
  ready: () => boolean,
  act: () => void,
  onTimeout?: () => void,
  timeoutMs: number = COLD_START_TIMEOUT_MS,
): () => void {
  if (ready()) {
    act();
    return () => {};
  }
  let done = false;
  // Watch the boolean directly (not a fresh [a, b] array, which compares
  // unequal every tick) so the callback runs only when readiness actually flips.
  const stop = watch(ready, (ok) => {
    if (!ok) return;
    cleanup();
    act();
  });
  const timer = setTimeout(() => {
    cleanup();
    onTimeout?.();
  }, timeoutMs);
  function cleanup(): void {
    if (done) return;
    done = true;
    stop();
    clearTimeout(timer);
  }
  return cleanup;
}
