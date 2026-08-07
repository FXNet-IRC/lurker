// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Router } from 'vue-router';

/**
 * True when there is an entry of OUR OWN to go back to.
 *
 * vue-router records the previous location in `history.state.back`; it is null
 * on the first entry of a document. That distinction only started mattering
 * once inner screens got real URLs (#744/#200): a screen that used to be
 * reachable solely by navigating into it can now be opened cold — refreshed,
 * bookmarked, shared — and `history.back()` from there either does nothing or
 * leaves the app entirely.
 */
export function canGoBack(): boolean {
  try {
    return !!(window.history.state as { back?: string | null } | null)?.back;
  } catch {
    return false;
  }
}

/** Go back if we came from somewhere, otherwise navigate to `fallback`. */
export function backOrPush(router: Router, fallback: string): void {
  if (canGoBack()) router.back();
  else void router.push(fallback);
}
