// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deployment config the client reads once at boot from the public /api/config
// endpoint. Today it carries only the edition (self-hosted standalone vs a
// hosted lurker.chat cell), which the Settings UI uses to gate operator-only
// surfaces (A3). Defaults to 'standalone' so a fetch failure degrades to the
// fully-featured self-hosted experience rather than hiding things wrongly.

import { defineStore } from 'pinia';
import { api } from '../api.js';

export type Edition = 'standalone' | 'node';

export const useConfigStore = defineStore('config', {
  state: () => ({
    edition: 'standalone' as Edition,
    // True when this instance binds every account to one network (FXNet lock):
    // the UI then hides add/remove-network and the destination fields.
    networkLock: false,
    // True when anonymous guest access is enabled (FXNet public webchat): the
    // router sends unauthenticated visitors to the join-as-guest landing rather
    // than the login page.
    publicMode: false,
    checked: false,
  }),
  getters: {
    // True when this client is talking to a hosted cell, not a self-hosted box.
    isNode: (s): boolean => s.edition === 'node',
    // True when accounts are locked to a single network on this instance.
    isNetworkLocked: (s): boolean => s.networkLock,
    // True when visitors can join the chat without an account.
    isPublicMode: (s): boolean => s.publicMode,
  },
  actions: {
    async fetch(): Promise<Edition> {
      try {
        const data = await api<{ edition?: string; networkLock?: boolean; publicMode?: boolean }>(
          '/api/config',
        );
        this.edition = data.edition === 'node' ? 'node' : 'standalone';
        this.networkLock = data.networkLock === true;
        this.publicMode = data.publicMode === true;
      } catch (_err) {
        this.edition = 'standalone';
        this.networkLock = false;
        this.publicMode = false;
      } finally {
        this.checked = true;
      }
      return this.edition;
    },
  },
});
