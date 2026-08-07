// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Sidebar order across all networks. Mirrors the visual layout in BufferList:
// per network, the server pseudo-buffer first, then pinned buffers in their
// stored order, then unpinned buffers (channels alphabetically before DMs
// alphabetically). Used by keyboard navigation so prev/next-channel and the
// quick switcher walk the same order the user sees in the sidebar.

import { isChannelTarget, stripChannelPrefix } from '../../../shared/channels.js';

interface BufferEntry {
  target: string;
}

interface Network {
  id: string | number;
}

interface PinsStore {
  forNetwork(networkId: string | number): string[] | null | undefined;
}

interface BuffersStore {
  forNetwork(networkId: string | number): BufferEntry[];
  byKey(key: string): { unread: number } | null | undefined;
}

// The FRIENDS/FAVORITES sections (two kind-filtered views of the one global
// favorites list) are injected at the top so keyboard nav / quick-switch walk
// the same order the sidebar renders. `excludeKeys` drops those buffers from
// their real network group so they aren't visited twice.
export interface FavoritesOrder {
  friends: Array<{ networkId: string | number; target: string }>;
  channels: Array<{ networkId: string | number; target: string }>;
  // `${networkId}::${lowercased target}` keys of every favorite.
  excludeKeys: Set<string>;
}

interface BufferOrderArgs {
  networks: Network[];
  buffers: BuffersStore;
  pins: PinsStore;
  favorites?: FavoritesOrder;
}

// Sentinel group ids for the two favorites sections — their members carry
// their real networkId for activation but group together, apart from that
// network. Non-numeric strings so they can never alias a real network id.
export const FRIENDS_GROUP_ID = 'group:friends';
export const FAVORITES_GROUP_ID = 'group:favorites';

interface BufferOrderEntry {
  networkId: string | number;
  target: string;
  // The activeKey for this entry — `${networkId}::${target}` for real buffers.
  // Callers match the active buffer and re-activate against this rather than
  // recomputing.
  key: string;
  // Logical group this entry belongs to: the networkId for real buffers, a
  // section sentinel for favorites (so they group apart from their
  // underlying network).
  groupId: string | number;
}

function isServerTarget(target: string): boolean {
  return typeof target === 'string' && target.startsWith(':server:');
}

// Alphabetical sort key for a buffer: leading channel sigils stripped, ASCII-
// lowercased (matching the house case-folding style). Exported so the quick
// switcher's smart sort (#393) alphabetises identically to the sidebar.
//
// ⚠ All four sigils, not just `#` (#724) — the comment always said "channel sigils", but the
// pattern stripped only one of them, so `&local` sorted under `&` instead of alongside `#local`.
export function bufferSortKey(target: string): string {
  return stripChannelPrefix(target).toLowerCase();
}

function bufferOrder(target: string): number {
  return isChannelTarget(target) ? 0 : 1;
}

// Returns a flat array of { networkId, target, key } entries in sidebar order.
export function flattenBufferOrder({
  networks,
  buffers,
  pins,
  favorites,
}: BufferOrderArgs): BufferOrderEntry[] {
  const out: BufferOrderEntry[] = [];
  const exclude = favorites?.excludeKeys;
  const isExcluded = (networkId: string | number, target: string): boolean =>
    !!exclude && exclude.has(`${networkId}::${target.toLowerCase()}`);

  // Favorites sections first (matches the sidebar): FRIENDS then FAVORITES.
  for (const dm of favorites?.friends || []) {
    out.push({
      networkId: dm.networkId,
      target: dm.target,
      key: `${dm.networkId}::${dm.target}`,
      groupId: FRIENDS_GROUP_ID,
    });
  }
  for (const ch of favorites?.channels || []) {
    out.push({
      networkId: ch.networkId,
      target: ch.target,
      key: `${ch.networkId}::${ch.target}`,
      groupId: FAVORITES_GROUP_ID,
    });
  }

  for (const net of networks) {
    const serverTarget = `:server:${net.id}`;
    out.push({
      networkId: net.id,
      target: serverTarget,
      key: `${net.id}::${serverTarget}`,
      groupId: net.id,
    });

    const pinnedTargets = pins.forNetwork(net.id) || [];
    const pinnedSet = new Set(pinnedTargets);
    const all = buffers.forNetwork(net.id);
    const byTarget = new Map<string, BufferEntry>();
    for (const b of all) byTarget.set(b.target, b);

    for (const t of pinnedTargets) {
      if (byTarget.has(t) && !isExcluded(net.id, t))
        out.push({ networkId: net.id, target: t, key: `${net.id}::${t}`, groupId: net.id });
    }

    const unpinned = all
      .filter(
        (b) =>
          !isServerTarget(b.target) && !pinnedSet.has(b.target) && !isExcluded(net.id, b.target),
      )
      .toSorted((a, b) => {
        const oa = bufferOrder(a.target);
        const ob = bufferOrder(b.target);
        if (oa !== ob) return oa - ob;
        return bufferSortKey(a.target).localeCompare(bufferSortKey(b.target));
      });
    for (const b of unpinned)
      out.push({
        networkId: net.id,
        target: b.target,
        key: `${net.id}::${b.target}`,
        groupId: net.id,
      });
  }
  return out;
}

// Same shape as flattenBufferOrder but only entries with unread > 0. Server
// pseudo-buffers participate (network-level notices land there).
export function flattenUnreadOrder(args: BufferOrderArgs): BufferOrderEntry[] {
  const { buffers } = args;
  return flattenBufferOrder(args).filter((entry) => {
    const buf = buffers.byKey(entry.key);
    return !!buf && buf.unread > 0;
  });
}
