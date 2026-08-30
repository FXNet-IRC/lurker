<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  The attach menu, behind the paperclip. One entry point for every way a file gets
  into a message: pick one off the disk, shoot one on the spot, or reuse one you
  starred earlier.

  The paperclip used to open the OS file dialog directly, and starred uploads got
  their own button next to it. That was two controls for one intent, and the star
  had to hide itself when you had no favourites to avoid offering an empty panel.
  Folding both into the paperclip means the second control disappears and the menu
  is never empty — with no favourites it is simply the upload actions, which is
  what the paperclip always did.

  A GRID of thumbnails rather than VerticalPopover's rows, because recognition here
  is visual: a column of tiny thumbs beside filenames is exactly the squint the
  uploads browser moved away from (#547). It follows MircColorPicker's shape
  instead — a panel absolutely positioned inside StatusBar's positioning context.

  ⚠ It inherits that popover's iOS focus contract: `div role=button` with
  @mousedown.prevent, acting on `click` (end of touch), never pointerdown. Losing
  focus would dismiss the soft keyboard mid-compose, and inserting into a textarea
  that just lost its caret puts the URL in the wrong place. The two upload actions
  are the deliberate exception — see the note on them.
-->

<template>
  <div ref="panelEl" class="upload-menu" @pointerdown.stop @mousedown.prevent.stop>
    <div class="head">
      <!-- The title IS the mode switch when there is something to switch between.
           A separate heading plus a pair of tabs is two rows of chrome on a panel
           whose whole job is being smaller than the uploads browser. -->
      <div v-if="showList" class="modes" role="group" aria-label="Which uploads to show">
        <div
          v-for="m in MODES"
          :key="m.value"
          role="button"
          class="mode"
          :class="{ active: uploads.menuMode === m.value }"
          tabindex="0"
          :aria-pressed="uploads.menuMode === m.value"
          @mousedown.prevent
          @click="onMode(m.value)"
          @keydown.enter.prevent="onMode(m.value)"
          @keydown.space.prevent="onMode(m.value)"
        >
          {{ m.label }}
        </div>
      </div>
      <span v-else class="title">attach</span>
      <div
        role="button"
        class="close"
        tabindex="0"
        title="Close"
        aria-label="Close"
        @mousedown.prevent
        @click="emit('close')"
        @keydown.enter.prevent="emit('close')"
        @keydown.space.prevent="emit('close')"
      >
        <i class="fa-solid fa-xmark"></i>
      </div>
    </div>

    <!-- Absent entirely when there is nothing to show, or when no composer is
         subscribed to the insert bus — inserting into nothing does nothing,
         silently. The upload actions below still work in both cases, so the menu
         always has a reason to exist. -->
    <template v-if="showList">
      <!-- The error rides ABOVE the grid rather than replacing it: every open
           refetches, and a failed refresh should not take away the perfectly
           usable list from the last one. -->
      <p v-if="uploads.menuError" class="note error">{{ uploads.menuError }}</p>
      <p v-else-if="emptyStarred" class="note">
        Nothing starred yet. Star an upload in the uploads browser to keep it here.
      </p>
      <!-- Dimmed while a load is in flight. The active tab does NOT move until the
           rows it names have arrived (see loadMenu), so without this a switch on a
           slow link looks like the tap missed. -->
      <div class="grid" :class="{ loading: uploads.menuLoading }" :aria-busy="uploads.menuLoading">
        <div
          v-for="u in uploads.menuItems"
          :key="u.id"
          role="button"
          class="cell"
          tabindex="0"
          :title="u.filename || u.url"
          :aria-label="`Insert ${u.filename || u.url}`"
          @mousedown.prevent
          @click="pick(u)"
          @keydown.enter.prevent="pick(u)"
          @keydown.space.prevent="pick(u)"
        >
          <img v-if="u.thumbnail_url" :src="u.thumbnail_url" class="art" alt="" loading="lazy" />
          <div v-else class="art art-icon">
            <i class="fa-solid" :class="iconForMime(u.mime)"></i>
          </div>
        </div>
      </div>
    </template>

    <!-- ⚠ These two must let the tap BLUR the composer, unlike everything else in
         this panel. Both open a native OS sheet, which dismisses the soft keyboard
         no matter what we do; preventing the tap-blur only delays that by a beat —
         keyboard up, then dropping as the sheet animates in — which reads as jank.
         Letting the tap blur gives one clean dismissal. (This is the reasoning that
         used to live on the paperclip itself, which now opens this panel instead.)

         ⚠⚠ `@mousedown.stop` is what BUYS that, and omitting the `.prevent` is not
         enough on its own: the panel root's `@mousedown.prevent.stop` also fires as
         the event bubbles up through it, and a preventDefault during bubbling still
         cancels the focus change. Without stopping here, the exception documented
         above silently does nothing. -->
    <div class="actions">
      <button type="button" class="action" @mousedown.stop @click="onUploadFile">
        <i class="fa-solid fa-folder-open"></i> Upload file
      </button>
      <!-- Touch only. `capture` is ignored by desktop browsers, so the button
           would just be a second, worse "Upload file" there. `canHover` is the
           same signal the build's hover gating uses, so CSS and behaviour agree. -->
      <button v-if="!canHover" type="button" class="action" @mousedown.stop @click="onOpenCamera">
        <i class="fa-solid fa-camera"></i> Camera
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useUploadsStore } from '../stores/uploads.js';
import type { UploadItem, UploadMenuMode } from '../stores/uploads.js';
import { useViewport } from '../composables/useViewport.js';
import { pickComposerFile, pickComposerCamera } from '../composables/useComposerOverlay.js';
import { iconForMime } from '../utils/uploaders.js';

const props = withDefaults(
  defineProps<{
    // Elements whose taps must NOT dismiss the panel — the toggle button, whose own
    // click handler owns open/close. Without it the document listener closes on
    // pointerdown and the button's click immediately reopens: a toggle that never
    // toggles off. Same contract as VerticalPopover's `ignore`.
    ignore?: readonly (HTMLElement | null)[];
  }>(),
  { ignore: () => [] },
);

const emit = defineEmits<{ close: [] }>();

const MODES: Array<{ label: string; value: UploadMenuMode }> = [
  { label: 'starred', value: 'favorites' },
  { label: 'recent', value: 'recent' },
];

const uploads = useUploadsStore();
const { canHover } = useViewport();
const panelEl = ref<HTMLElement | null>(null);

// The list section, mode switch included. Hidden when there is nothing this panel
// could insert: no composer listening, or an account with no uploads at all —
// openMenu already fell back from starred to recent, so an empty list in 'recent'
// mode means there is genuinely nothing, and a mode switch over two empty lists is
// just noise above the upload buttons.
const showList = computed(
  () => uploads.canInsert && (uploads.menuItems.length > 0 || uploads.menuMode === 'favorites'),
);

// Starred mode, deliberately chosen (openMenu only lands here when there IS
// something starred), and then emptied — you unstarred the last one from the
// browser while the menu was open. Explains the empty grid rather than leaving it
// looking broken.
const emptyStarred = computed(
  () => uploads.menuMode === 'favorites' && !uploads.menuItems.length && !uploads.menuLoading,
);

function onMode(mode: UploadMenuMode): void {
  if (uploads.menuMode === mode) return;
  // selectMenuMode, not loadMenu: this is a choice, and it has to outlive the panel
  // rather than be re-decided by the next open's starred-by-default rule.
  void uploads.selectMenuMode(mode);
}

function pick(u: UploadItem): void {
  // The store's insert bus reaches MessageInput wherever it is mounted, so the
  // menu never needs a reference to the composer. insertUrlAtCaret refocuses the
  // textarea, which is what keeps the iOS keyboard up through the pick.
  uploads.requestInsert(u.url);
  emit('close');
}

// Close first: the panel is a sibling of the native sheet about to cover the
// screen, and leaving it mounted underneath means it is still there when the user
// cancels out of the file dialog.
function onUploadFile(): void {
  emit('close');
  pickComposerFile();
}

function onOpenCamera(): void {
  emit('close');
  pickComposerCamera();
}

function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (panelEl.value?.contains(target)) return;
  for (const el of props.ignore) {
    if (el?.contains(target)) return;
  }
  emit('close');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  // Every open, not once per session: uploads and stars both happen on other
  // devices. openMenu also picks the mode — starred when there is a starred set,
  // recent when there isn't.
  void uploads.openMenu();
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
/* Anchored to StatusBar's bottom-right and growing upward, matching
   MircColorPicker — the bar's own content area is one short row, so both of its
   popovers open toward the message list. */
.upload-menu {
  position: absolute;
  right: var(--space-6);
  bottom: var(--space-3);
  background: var(--bg);
  border: 1px solid var(--border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  z-index: var(--z-raised);
  /* A DEFINITE width, not a max-width. Shrink-to-fit plus fixed grid tracks left
     whatever didn't divide evenly as dead space down the right-hand edge; the
     thumbs can only share the leftovers (see .grid) if there is a known width for
     them to share. Narrow enough to leave the bar readable behind it on a phone. */
  width: min(320px, calc(100vw - 2 * var(--space-6)));
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  color: var(--fg-muted);
}
/* Reads as the panel's title until you notice the inactive word is clickable —
   which is the intent. Underline rather than a chip border: at this size a pair of
   bordered chips is more chrome than the grid they label. */
.modes {
  display: flex;
  gap: var(--space-4);
  min-width: 0;
}
.mode {
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  border-bottom: 1px solid transparent;
}
.mode:hover {
  color: var(--fg);
}
.mode.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
.mode:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.close {
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
}
.close:hover {
  color: var(--accent);
}
.close:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.note {
  margin: 0;
  color: var(--fg-muted);
}
.note.error {
  color: var(--bad);
}
.grid {
  display: grid;
  /* minmax(_, 1fr), not a fixed track: whatever the panel's width doesn't divide
     into whole columns gets shared back out to the thumbs instead of pooling as
     dead space on the right. The floor sets how many fit — three, at this width —
     and they grow from there. Recognising a gif at a glance is the entire job, so
     the space is better spent on bigger squares than on more of them.

     auto-fill, not auto-fit: one starred file should sit at thumb size on the
     left, not stretch across the whole panel. */
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: var(--space-2);
  /* About three rows before it scrolls. Past that the menu has stopped being quick
     access and the uploads browser is the right tool. */
  max-height: min(320px, 45vh);
  overflow-y: auto;
}
.grid.loading {
  opacity: 0.5;
  transition: opacity 0.12s ease;
}
.cell {
  cursor: pointer;
  line-height: 0;
  touch-action: manipulation;
}
.art {
  width: 100%;
  /* Square via aspect-ratio rather than a fixed height, so the thumb follows the
     column width the grid just handed it. Matches the server thumbnail's own
     centre cover-crop geometry, same as the uploads browser's tiles. */
  aspect-ratio: 1;
  object-fit: cover;
  background: var(--bg-soft);
  border: 1px solid var(--border);
}
.art-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  line-height: 1;
}
.cell:hover .art {
  border-color: var(--accent);
}
.cell:focus-visible {
  outline: none;
}
.cell:focus-visible .art {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* Real <button>s, not the div role=button the rest of the panel uses: these are
   the one place focus SHOULD leave the textarea (a native sheet takes it anyway),
   so there is nothing to protect and a button is the honest element. */
.actions {
  display: flex;
  gap: var(--space-2);
}
.action {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  /* The iOS minimum. This is the primary action of the panel on a phone, and it
     sits directly above the composer — an undersized target here is the one that
     actually gets mis-tapped. */
  min-height: 44px;
  padding: var(--space-3) var(--space-4);
  background: none;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.action:hover {
  color: var(--fg);
  border-color: var(--accent);
}
.action:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
</style>
