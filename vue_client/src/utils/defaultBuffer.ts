// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * Should the desktop shell open the system buffer as its landing target?
 *
 * Desktop has no "no buffer selected" screen the way mobile's list is, so it
 * falls back to the system buffer rather than a blank pane (#355).
 *
 * The route half of this is load-bearing and easy to lose. `activeKey == null`
 * alone used to mean "nothing has claimed a buffer", because a deep link set one
 * synchronously. Under URL routing (#744) it cannot: resolving `/buffer/7` needs
 * the socket and the buffer list, so activeKey IS null at mount on a cold deep
 * link. Falling back then doesn't just show the wrong thing for a moment — the
 * system buffer's own row id arrives in the backlog frame, the activeKey→URL
 * binding treats that as a navigation, and it pushes `/buffer/<system>` over the
 * link the user opened. Bookmarks, refreshes and "Copy link to message" URLs all
 * land on the system console instead.
 *
 * Deliberately NOT solved inside useBufferRoute by refusing to move the URL
 * while a resolution is pending: a user who clicks another buffer mid-resolve
 * must still win, or they'd sit on a URL naming somewhere they aren't and get
 * yanked away when it finally resolves. The distinction is default-vs-deliberate,
 * which only the call site knows.
 */
export function shouldOpenSystemBufferOnLoad(
  activeKey: string | null | undefined,
  routeBufferId: unknown,
): boolean {
  return activeKey == null && routeBufferId == null;
}
