<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <AppModal word="note" :title="`note on ${nick}`" size="md" @close="onClose">
    <form class="modal-form" @submit.prevent="confirm">
      <div class="body">
        <textarea
          ref="inputEl"
          :value="draft"
          @input="onDraftInput"
          spellcheck="true"
          autocapitalize="sentences"
          rows="8"
          :maxlength="MAX_LEN"
          placeholder="e.g. lives in Berlin, works at Acme, spouse: Pat…"
        ></textarea>
        <p class="meta">
          <span v-if="entry?.updatedAt">Updated {{ formattedUpdatedAt }}</span>
          <span v-else>Notes are private to you and synced across your devices.</span>
        </p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="btn-secondary" @click="onClose">Cancel</button>
        <button v-if="hasExistingNote" type="button" class="btn-secondary danger" @click="onDelete">
          Delete
        </button>
        <button type="submit" class="btn-primary" :disabled="!dirty">Save</button>
      </footer>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { formatDateTime } from '../utils/timestamp.js';
import { useImeSafeInput } from '../composables/useImeSafeInput.js';

const props = defineProps<{
  nick: string;
  networkId: number;
}>();

const MAX_LEN = 4096;
const nickNotes = useNickNotesStore();
const inputEl = ref<HTMLTextAreaElement | null>(null);

const entry = computed(() => nickNotes.entryFor(props.networkId, props.nick));
const initial = computed(() => entry.value?.note || '');
const draft = ref(initial.value);
const onDraftInput = useImeSafeInput(draft);
const dirty = computed(() => draft.value !== initial.value);
const hasExistingNote = computed(() => !!entry.value?.note);
const formattedUpdatedAt = computed(() => formatDateTime(entry.value?.updatedAt ?? ''));

function confirm() {
  if (!dirty.value) return;
  nickNotes.setNote(props.networkId, props.nick, draft.value);
  nickNotes.closeEditor();
}

function onDelete() {
  nickNotes.setNote(props.networkId, props.nick, '');
  nickNotes.closeEditor();
}

function onClose() {
  nickNotes.closeEditor();
}

onMounted(() => {
  setTimeout(() => {
    const el = inputEl.value;
    if (!el) return;
    el.focus();
    // Drop the caret at the end of any existing text so editing feels like
    // appending, not replacing — common case for these notes is "add another
    // detail" rather than rewriting the whole thing.
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch (_) {
      /* unsupported */
    }
  }, 0);
});
</script>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Breathing room so the last content doesn't butt against the footer divider
     when scrolled to the bottom. */
  padding-bottom: var(--space-7);
}
textarea {
  background: var(--bg-soft);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: var(--space-4) var(--space-5);
  font: inherit;
  resize: vertical;
  min-height: 8em;
  line-height: 1.45;
}
textarea:focus {
  outline: 1px solid var(--accent);
}
.meta {
  margin: 0;
  color: var(--fg-muted);
}
</style>
