// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

function key(networkId: number | string, target: string) {
  return `${networkId}::${target}`;
}

// Per-buffer history of every line submitted through the input bar (chat,
// /raw, even client-only lines like /commands). Server is the source of
// truth; this store mirrors the most-recent slice the server ships on snapshot
// plus optimistic local appends on submit. MessageInput drives up/down recall
// off `forBuffer`.
export const useInputHistoryStore = defineStore('inputHistory', {
  state: () => ({
    history: {} as Record<string, string[]>,
  }),
  getters: {
    forBuffer: (state) => (networkId: number | string, target: string) =>
      state.history[key(networkId, target)] || [],
  },
  actions: {
    seed(networkId: number | string, target: string, entries: string[]) {
      if (!Array.isArray(entries)) return;
      this.history[key(networkId, target)] = entries.slice();
    },
    add(networkId: number | string, target: string, text: string) {
      if (!text) return;
      const k = key(networkId, target);
      const arr = this.history[k] || [];
      this.history[k] = [...arr, text];
    },
    drop(networkId: number | string, target: string) {
      delete this.history[key(networkId, target)];
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts).
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      this.drop(networkId, target);
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = key(networkId, from);
      const toKey = key(networkId, to);
      if (!this.history[fromKey]) return;
      // Destination wins on a merge collision; the source mirror is dropped
      // (the server's merged slice re-seeds on next open anyway).
      if (!this.history[toKey]) this.history[toKey] = this.history[fromKey];
      delete this.history[fromKey];
    },
  },
});
