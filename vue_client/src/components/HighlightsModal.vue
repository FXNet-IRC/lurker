<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="highlights" title="highlights" size="lg" fill-height @close="$emit('close')">
    <template #actions>
      <button
        class="link sound-toggle"
        :title="soundEnabled ? 'mute highlight sound' : 'unmute highlight sound'"
        @click="toggleSound"
      >
        <i :class="soundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark'"></i>
      </button>
    </template>

    <div class="search-row">
      <input
        :value="queryInput"
        @input="onQueryInput"
        class="filter"
        type="text"
        placeholder="filter highlights — from:nick in:#channel on:network"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <ul v-if="visibleItems.length" ref="listEl" class="match-list" @scroll="onScroll">
      <HistoryMessageRow
        v-for="m in visibleItems"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        @jump="onJump"
      />
      <li v-if="store.loading" class="more">Loading…</li>
    </ul>
    <p v-else-if="store.loading" class="empty">Loading…</p>
    <p v-else-if="store.items.length" class="empty">All highlights are from ignored users.</p>
    <p v-else-if="hasFilter" class="empty">No highlights match your filter.</p>
    <p v-else class="empty">No highlights yet.</p>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import HistoryMessageRow, { type HistoryMessage } from './HistoryMessageRow.vue';
import { useSettingsStore } from '../stores/settings.js';
import { useHighlightsStore } from '../stores/highlights.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

// `scope` (set when opened from a buffer's topic bar) runs the highlights feed
// filtered to this buffer. Unlike search this loads immediately — highlights is
// a filtered feed, not a type-to-search box, so the channel's highlights should
// be visible at a glance. The global session is snapshotted and restored on
// close so the list-bar highlights modal is unaffected.
const props = defineProps<{ scope?: string | null }>();
const scoped = !!props.scope;

const settings = useSettingsStore();
const store = useHighlightsStore();
const ignores = useIgnoresStore();
let scopedSnapshot: typeof store.$state | null = null;

const listEl = ref<HTMLUListElement | null>(null);

const visibleItems = computed(() =>
  store.items.filter((m) => !ignores.isMessageHidden(m.networkId, m)),
);

const hasFilter = computed(() => store.query.trim().length > 0);

// If the entire loaded page is from ignored users the scroll container is not
// rendered, so the user can't trigger pagination themselves — quietly fetch
// the next page in their stead. Capped so a single very prolific ignored
// source can't drag the modal into an unbounded fetch loop; reset whenever the
// filter changes so a fresh result set gets its own budget.
const AUTO_FILL_MAX_PAGES = 5;
let autoFillFetched = 0;

// Local mirror of the store's raw filter so we can debounce the reload without
// debouncing the text field itself. Seeded from the store so a closed-then-
// reopened modal keeps the active filter.
const queryInput = ref(scoped ? `${props.scope} ` : store.query);
const onQueryInput = useImeSafeInput(queryInput);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(queryInput, (val) => {
  store.setQuery(val);
  autoFillFetched = 0; // New filter — let auto-fill work again.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    // skipIfSameFilter: this watcher fires on no-op input changes too (a
    // trailing space, a half-typed filter token) — don't blank + refetch.
    store.loadInitial(true);
  }, 200);
});
onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  // Discard the scoped session, restoring the store for the global modal.
  if (scoped && scopedSnapshot) store.$patch(scopedSnapshot);
});

function onScroll(): void {
  const el = listEl.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    store.loadMore();
  }
}

watch(
  () => [visibleItems.value.length, store.loading, store.hasMore] as const,
  ([visible, loading, hasMore]) => {
    if (visible === 0 && hasMore && !loading && autoFillFetched < AUTO_FILL_MAX_PAGES) {
      autoFillFetched += 1;
      store.loadMore();
    }
  },
);

const soundEnabled = computed(() => !!settings.effective('notifications.highlight.sound.enabled'));

async function toggleSound(): Promise<void> {
  try {
    await settings.setValue('notifications.highlight.sound.enabled', !soundEnabled.value);
  } catch (_) {
    /* setting writes are best-effort from the modal */
  }
}

onMounted(() => {
  if (scoped) {
    // Snapshot the global session, then seed the scoped filter before the
    // initial load so the feed opens showing this buffer's highlights.
    scopedSnapshot = { ...store.$state };
    store.setQuery(queryInput.value);
  }
  store.loadInitial();
});

function onJump(m: HistoryMessage): void {
  emit('jump', { networkId: m.networkId, target: m.target, messageId: Number(m.id) });
  emit('close');
}
</script>

<style scoped>
.link {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font: inherit;
  padding: 0 var(--space-2);
}
.link:hover {
  color: var(--accent);
}
.link:disabled {
  opacity: 0.5;
  cursor: default;
}
.sound-toggle {
  /* Icon-only button — size the glyph (fa-solid is already weight 900, so
     font-weight here would be a no-op). */
  font-size: var(--icon-md);
}

.search-row {
  margin-bottom: var(--space-6);
}
.filter {
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  font: inherit;
}
.filter:focus {
  outline: none;
  border-color: var(--accent);
}

.match-list {
  list-style: none;
  /* Break out of card padding so the scrollbar sits against the card
     border; padding keeps row content visually aligned with the rest. */
  margin: 0 calc(-1 * var(--card-pad-x));
  padding: 0 var(--card-pad-x);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.more {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-4);
}
.empty {
  text-align: center;
  color: var(--fg-muted);
  font-style: italic;
  padding: var(--space-10);
}
.error.inline {
  color: var(--bad);
  padding: var(--space-4) 0;
  margin: 0;
}
</style>
