// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Virtual buffers are sidebar-selectable "buffers" that aren't tied to an IRC
// network. They use a flat sentinel key (no `::`) so the usual
// `${networkId}::${target}` parsers ignore them. Today there is one:
//
//   :system:  — the system buffer (issue #355). A real, app-scoped Buffer in
//               the buffers store (networkId null), rendered by MessageList
//               with a slash-command input and no nicklist. It's the home for
//               the server lifecycle log plus command output / errors that
//               have no other buffer.
//
// hasInput/hasNicklist are load-bearing: useActiveBuffer surfaces them and the
// views dispatch the input row + member list off them, so a future
// :highlights: buffer is one registry entry — not another round of scattered
// `=== ':system:'` checks. (A virtual pane rendered by a bespoke component
// instead of MessageList would need a renderMode field again — the removed
// Friends overview was the model.)

export const SYSTEM_KEY = ':system:';

export interface VirtualBufferConfig {
  key: string;
  label: string;
  hasNicklist: boolean;
  hasInput: boolean;
}

export const VIRTUAL_BUFFERS: Readonly<Record<string, VirtualBufferConfig>> = Object.freeze({
  [SYSTEM_KEY]: {
    key: SYSTEM_KEY,
    label: 'Lurker',
    hasNicklist: false,
    hasInput: true,
  },
});

export function isVirtualKey(key: string | null | undefined): boolean {
  return !!key && Object.prototype.hasOwnProperty.call(VIRTUAL_BUFFERS, key);
}

export function virtualConfig(key: string | null | undefined): VirtualBufferConfig | null {
  return key && isVirtualKey(key) ? VIRTUAL_BUFFERS[key] : null;
}
