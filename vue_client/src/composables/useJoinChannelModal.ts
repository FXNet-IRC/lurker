// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';

// Shared open-state for the "Join Channel" modal (#411). Mirrors
// useChannelListModal: a singleton network-scoped toggle so any surface (a
// network header's + button, the server-buffer topic bar, the mobile kebab)
// opens the same modal instance.
const isOpen = ref(false);
const networkId = ref<number | null>(null);

export function useJoinChannelModal() {
  function open(id: number): void {
    networkId.value = id;
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
    networkId.value = null;
  }
  return { isOpen, networkId, open, close };
}
