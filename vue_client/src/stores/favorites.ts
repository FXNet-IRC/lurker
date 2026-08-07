// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { idFor, useBuffersStore } from './buffers.js';
import { isChannelTarget } from '../../../shared/channels.js';

// Buffer favorites — the Friends/Contacts replacement. ONE per-user global
// ordered list spanning networks; the sidebar renders it as two kind-filtered
// sections ("Friends" = query buffers, "Favorites" = channels). The server is
// the source of truth: mutations send a WS message and wait for the
// `favorites-changed` echo (the full ordered list, replace wholesale — the
// same frame seeds the connect burst). Drag UX still feels instant because
// vuedraggable updates its own local order during the drag; this store
// catches up on drop.

export interface FavoriteEntry {
  networkId: number;
  target: string;
  bufferId: number;
}

export const useFavoritesStore = defineStore('favorites', {
  state: () => ({
    entries: [] as FavoriteEntry[],
  }),
  getters: {
    isFavorite: (state) => (networkId: number | string, target: string) => {
      const folded = target.toLowerCase();
      return state.entries.some(
        (e) => e.networkId === Number(networkId) && e.target.toLowerCase() === folded,
      );
    },
    favoriteKeys: (state) =>
      new Set(state.entries.map((e) => `${e.networkId}::${e.target.toLowerCase()}`)),
    // The two kind-filtered views of the one global list, in global order —
    // what the sidebar sections render and keyboard nav / the quick switcher
    // walk. Entries whose buffer hasn't materialized yet are skipped (they
    // surface once hydration lands), so consumers never see a dead row.
    // `target` is re-resolved to the LOCAL buffer's casing: the entry carries
    // the server-canonical spelling, but a client-materialized buffer can hold
    // a divergent case (first-writer-wins, #327), and downstream consumers do
    // exact `${networkId}::${target}` key lookups — an entry-cased key would
    // miss the buffer, dropping it from unread-nav while excludeKeys still
    // removed it from its network group (unreachable).
    sections(state): { friends: FavoriteEntry[]; channels: FavoriteEntry[] } {
      const buffers = useBuffersStore();
      const friends: FavoriteEntry[] = [];
      const channels: FavoriteEntry[] = [];
      for (const e of state.entries) {
        const buf = buffers.findByTarget(e.networkId, e.target);
        if (!buf) continue;
        if (buf.kind === 'server' || buf.kind === 'system') continue;
        const resolved = buf.target === e.target ? e : { ...e, target: buf.target };
        // Split by channel PREFIX, not buf.kind: the client's deriveKind only
        // knows '#', but the server counts '&'/'+'/'!' channels too
        // (kindForTarget) — a favorited &local must land under FAVORITES with
        // channel chrome, not under FRIENDS with a bogus presence dot.
        if (isChannelTarget(buf.target)) channels.push(resolved);
        else friends.push(resolved);
      }
      return { friends, channels };
    },
    // The ready-made bufferOrder injection ({friends, channels, excludeKeys})
    // for keyboard nav and the quick switcher. One owner: assembling it
    // field-by-field at each call site around an optional param invites a
    // caller that forgets it and silently walks a divergent, un-deduped order.
    orderInjection(): {
      friends: FavoriteEntry[];
      channels: FavoriteEntry[];
      excludeKeys: Set<string>;
    } {
      const secs = this.sections;
      return { friends: secs.friends, channels: secs.channels, excludeKeys: this.favoriteKeys };
    },
  },
  actions: {
    apply(entries: FavoriteEntry[]) {
      this.entries = Array.isArray(entries) ? [...entries] : [];
    },
    favorite(networkId: number | string, target: string) {
      socketSend({
        type: 'favorite-buffer',
        networkId,
        target,
        bufferId: idFor(networkId, target),
      });
    },
    unfavorite(networkId: number | string, target: string) {
      socketSend({
        type: 'unfavorite-buffer',
        networkId,
        target,
        bufferId: idFor(networkId, target),
      });
    },
    // A drag inside one kind-filtered section sends only that section's ids —
    // the server floats them to the front and keeps unmentioned favorites in
    // their existing relative order, so the other section is untouched.
    reorder(bufferIds: number[]) {
      socketSend({ type: 'reorder-favorites', bufferIds });
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts). Belt-and-suspenders: the
    // server's favorites-changed echo is authoritative (close⇒unfavorite,
    // merges, and hard deletes all republish), but the sweep keeps the local
    // mirror honest in the gap.
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      const folded = target.toLowerCase();
      this.entries = this.entries.filter(
        (e) => !(e.networkId === Number(networkId) && e.target.toLowerCase() === folded),
      );
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const folded = from.toLowerCase();
      // Destination wins on a rename/merge collision (matching the buffers
      // store): if `to` is already a favorite, mapping `from` onto it would
      // duplicate the entry — drop the source instead. The server's follow-up
      // favorites-changed corrects ids either way.
      const toExists = this.isFavorite(networkId, to);
      this.entries = toExists
        ? this.entries.filter(
            (e) => !(e.networkId === Number(networkId) && e.target.toLowerCase() === folded),
          )
        : this.entries.map((e) =>
            e.networkId === Number(networkId) && e.target.toLowerCase() === folded
              ? { ...e, target: to }
              : e,
          );
    },
  },
});
