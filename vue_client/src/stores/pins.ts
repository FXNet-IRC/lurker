// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { idFor } from './buffers.js';

// Pinned buffers per network, in user-controlled order. The server is the
// source of truth: mutations send a WS message and wait for the `pins-changed`
// echo to update state. Drag UX still feels instant because vuedraggable
// updates its own local order during the drag; this store catches up on drop.
export const usePinsStore = defineStore('pins', {
  state: () => ({
    byNetwork: {} as Record<number | string, string[]>,
  }),
  getters: {
    forNetwork: (state) => (networkId: number | string) => state.byNetwork[networkId] || [],
    isPinned: (state) => (networkId: number | string, target: string) =>
      (state.byNetwork[networkId] || []).includes(target),
  },
  actions: {
    setNetwork(networkId: number | string, pinned: string[]) {
      this.byNetwork[networkId] = Array.isArray(pinned) ? [...pinned] : [];
    },
    applySnapshot(networks: any[]) {
      const next: Record<number | string, string[]> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = [...(n.pinned || [])];
      }
      this.byNetwork = next;
    },
    pin(networkId: number | string, target: string) {
      socketSend({ type: 'pin-buffer', networkId, target, bufferId: idFor(networkId, target) });
    },
    unpin(networkId: number | string, target: string) {
      socketSend({ type: 'unpin-buffer', networkId, target, bufferId: idFor(networkId, target) });
    },
    reorder(networkId: number | string, targets: string[]) {
      socketSend({ type: 'reorder-pins', networkId, targets });
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts). Belt-and-suspenders for pins:
    // the server's pins-changed echo is authoritative, but the sweep keeps the
    // local mirror honest in the gap.
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      const list = this.byNetwork[networkId];
      if (list?.includes(target)) {
        this.byNetwork[networkId] = list.filter((t) => t !== target);
      }
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const list = this.byNetwork[networkId];
      if (!list?.includes(from)) return;
      // Destination wins on a rename/merge collision (matching the buffers
      // store): if `to` is already pinned, mapping `from` onto it would
      // duplicate the entry — drop the source pin instead.
      this.byNetwork[networkId] = list.includes(to)
        ? list.filter((t) => t !== from)
        : list.map((t) => (t === from ? to : t));
    },
  },
});
