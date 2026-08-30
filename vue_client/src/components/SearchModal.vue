<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="search" title="search" size="lg" fill-height @close="$emit('close')">
    <div class="search-row">
      <input
        ref="inputEl"
        :value="queryInput"
        @input="onQueryInput"
        class="filter"
        type="text"
        placeholder="search messages — from:nick in:#channel on:network"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <p v-if="store.error" class="error inline">{{ store.error }}</p>
    <ul v-if="visibleResults.length" ref="listEl" class="match-list" @scroll="onScroll">
      <HistoryMessageRow
        v-for="m in visibleResults"
        :key="`${m.networkId}::${m.target}::${m.id}`"
        :message="m"
        @jump="onJump"
      />
      <li v-if="store.loading" class="more">Loading…</li>
    </ul>
    <p v-else-if="store.loading" class="empty">Searching…</p>
    <p v-else-if="store.results.length" class="empty">All matches are from ignored users.</p>
    <p v-else-if="store.searched" class="empty">No matches.</p>
    <p v-else class="empty">Type to search your message history.</p>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import AppModal from './AppModal.vue';
import HistoryMessageRow from './HistoryMessageRow.vue';
import { useSearchStore } from '../stores/search.js';
import type { SearchResult } from '../stores/search.js';
import { useIgnoresStore } from '../stores/ignores.js';
import type { HistoryMessage } from './HistoryMessageRow.vue';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';

const emit = defineEmits<{
  close: [];
  jump: [payload: { networkId: number; target: string; messageId: number }];
}>();

// When `scope` is set (opened from a buffer's topic bar) the modal runs as an
// ephemeral, pre-filtered session: it seeds the in:/on: filter, starts from a
// clean slate, and restores the store on close so the *global* search modal's
// persisted "where I was" survives untouched.
const props = defineProps<{ scope?: string | null }>();
const scoped = !!props.scope;

const store = useSearchStore();
const ignores = useIgnoresStore();
let scopedSnapshot: typeof store.$state | null = null;

// The server already drops senders ignored when the message arrived (the
// insert-time from_ignored stamp). This second, live pass also hides anyone
// ignored *after* those messages were stored, and reactively restores rows on
// /unignore without re-issuing the query. Full-context match so level/channel/
// pattern-scoped rules are honored here too, not just whole-identity ignores.
const visibleResults = computed(() =>
  store.results.filter((m) => !ignores.isMessageHidden(m.networkId, m)),
);

const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

// Local mirror of the store's raw query so we can debounce dispatch without
// debouncing the text field itself. Scoped opens seed the prefilled filter.
const queryInput = ref(scoped ? `${props.scope} ` : store.query);
const onQueryInput = useImeSafeInput(queryInput);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(queryInput, (val) => {
  store.setQuery(val);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    store.runSearch();
  }, 200);
});

function onJump(m: HistoryMessage | SearchResult) {
  const id = typeof m.id === 'number' ? m.id : 0;
  emit('jump', { networkId: m.networkId, target: m.target, messageId: id });
  emit('close');
}

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
    store.loadMore();
  }
}

onMounted(() => {
  if (scoped) {
    // Snapshot the global session, then patch in a clean scoped slate so the
    // prefilled filter shows the "type to search" prompt rather than the
    // previous global results bleeding through.
    scopedSnapshot = { ...store.$state };
    store.$patch({
      query: queryInput.value,
      results: [],
      nextBefore: null,
      loading: false,
      error: '',
      searched: false,
      lastUrl: null,
      scrollTop: 0,
    });
  }
  setTimeout(() => {
    inputEl.value?.focus();
    if (scoped) {
      // Cursor after the filter (not select-all) so the first keystroke adds a
      // search term instead of wiping the scope.
      const len = inputEl.value?.value.length ?? 0;
      inputEl.value?.setSelectionRange(len, len);
    } else {
      inputEl.value?.select();
    }
  }, 0);
  // Restore the scroll position after the list has rendered.
  nextTick(() => {
    const el = listEl.value;
    if (el && store.scrollTop > 0) el.scrollTop = store.scrollTop;
  });
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (scoped && scopedSnapshot) {
    // Discard the scoped session and hand the store back to the global modal
    // exactly as we found it.
    store.$patch(scopedSnapshot);
    return;
  }
  // Persist DOM-only state back to the store so the next open restores it.
  // The Pinia store already keeps query, results, hasMore, nextBefore, and
  // searched across opens; this rounds out the user-perceived "where I was".
  store.scrollTop = listEl.value?.scrollTop || 0;
});
</script>

<style scoped>
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
