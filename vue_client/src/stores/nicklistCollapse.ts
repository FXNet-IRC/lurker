// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { idFor } from './buffers.js';

// Per-channel override for the desktop nicklist collapsed state. The server is
// the source of truth: a toggle sends a WS message and the `nicklist-collapsed
// -changed` echo updates state. Channels with no entry here fall back to the
// global look.layout.show_member_list default — see DesktopChat's showMembers.
export const useNicklistCollapseStore = defineStore('nicklistCollapse', {
  state: () => ({
    // { [networkId]: { [target]: boolean } } — true means collapsed (hidden).
    byNetwork: {} as Record<number | string, Record<string, boolean>>,
  }),
  getters: {
    // Returns the explicit override boolean, or undefined when the channel has
    // never been toggled (caller falls back to the global default).
    override: (state) => (networkId: number | string, target: string) =>
      state.byNetwork[networkId]?.[target],
  },
  actions: {
    setNetwork(networkId: number | string, map: Record<string, boolean>) {
      this.byNetwork[networkId] = { ...map };
    },
    applySnapshot(networks: any[]) {
      const next: Record<number | string, Record<string, boolean>> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = { ...n.collapsedNicklists };
      }
      this.byNetwork = next;
    },
    applyChange(networkId: number | string, target: string, collapsed: boolean) {
      if (!this.byNetwork[networkId]) this.byNetwork[networkId] = {};
      this.byNetwork[networkId][target] = collapsed;
    },
    setCollapsed(networkId: number | string, target: string, collapsed: boolean) {
      socketSend({
        type: 'set-nicklist-collapsed',
        networkId,
        target,
        collapsed,
        bufferId: idFor(networkId, target),
      });
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts).
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      const map = this.byNetwork[networkId];
      if (map && target in map) delete map[target];
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const map = this.byNetwork[networkId];
      if (!map || !(from in map)) return;
      // Destination wins on a merge collision.
      if (!(to in map)) map[to] = map[from];
      delete map[from];
    },
  },
});
