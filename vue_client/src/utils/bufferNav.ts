// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * Should activating buffer `id` produce a navigation?
 *
 * Two ways the answer is no: we are already there, or we are already on our way
 * there. The subtlety is WHICH source to believe. `router.push` resolves
 * asynchronously, so while a push is in flight the route still reports the
 * PREVIOUS buffer — that lag is the entire reason an in-flight target is
 * tracked at all, and consulting the route as well as it reintroduces the bug
 * from the other side:
 *
 *   at /buffer/7, activate #b(8)  -> push /buffer/8 starts, route still says 7
 *   activate #a(7) again          -> route says 7, so "already there", skip
 *   /buffer/8 lands               -> the inbound binding activates #b
 *
 * and the user's second choice is silently undone. So: while a push is in
 * flight it is the only thing worth comparing against; otherwise the route is
 * current and authoritative.
 *
 * Pure and separate from the composable because the race needs three specific
 * values to line up — a state a component harness can't reliably stage, since
 * activations in one scheduler flush coalesce into a single watcher run.
 */
export function shouldPushBuffer(
  id: number,
  routeId: number | null,
  inFlightId: number | null,
): boolean {
  return (inFlightId != null ? inFlightId : routeId) !== id;
}

/**
 * On the members screen, should this activation carry the user off it?
 *
 * Two activations reach a mounted members route and they must diverge:
 *
 *   - Send DM out of the nick menu: a DIFFERENT buffer became active, and
 *     holding would leave the user staring at the old channel's member list.
 *     Navigate.
 *   - A cold refresh (or bookmark/share) of `/buffer/:id/members`: the
 *     snapshot resolves and useBufferRoute activates the buffer the route
 *     ALREADY NAMES. Navigating here bounces to the chat screen the moment
 *     the app loads, and the members screen the URL asked for never renders.
 *     Hold.
 *
 * An id-less activation (an optimistic DM) can never be the routed buffer, so
 * it navigates — where its no-address handling takes over.
 */
export function shouldLeaveMembers(
  activeBufferId: number | null | undefined,
  routeIdParam: unknown,
): boolean {
  return activeBufferId == null || String(activeBufferId) !== routeIdParam;
}
