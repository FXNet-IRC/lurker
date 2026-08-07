<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <span
    class="spoiler"
    :class="{ revealed }"
    :style="wrapperStyle"
    :role="revealed ? undefined : 'button'"
    :tabindex="revealed ? undefined : 0"
    :aria-expanded="revealed ? undefined : 'false'"
    :aria-label="revealed ? undefined : 'Hidden spoiler, activate to reveal'"
    :title="revealed ? undefined : 'Hidden spoiler — click to reveal'"
    @click="reveal"
    @keydown.enter.prevent="reveal"
    @keydown.space.prevent="reveal"
    ><span class="spoiler-body" :style="bodyStyle" :aria-hidden="revealed ? undefined : 'true'">{{
      seg.text
    }}</span></span
  >
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { RenderSegment } from '../utils/nickColor.js';
import { mircColor } from '../utils/nickColor.js';
import { useMircPalette } from '../composables/useNickColors.js';

// Renders an IRC spoiler run (fg===bg, i.e. text deliberately coloured to be
// invisible) as a Discord-style blacked-out box. The content is kept out of
// the accessible name (aria-hidden) until revealed so a screen reader doesn't
// read the secret aloud. Reveal is one-way: once a user deliberately opens a
// spoiler, re-hiding it isn't a behaviour anyone expects.
//
// A DELIBERATE colour rides through on seg.fg (== seg.bg by construction) and
// paints the unrevealed box and the revealed text/tint, so a chatter who picked
// red gets a red spoiler rather than a generic gray one. The canonical `01,01`
// pair is excluded — see SPOILER_CONVENTION_COLOR: it encodes "hidden", not a
// colour, and treating it as one made revealed text invisible.
const props = defineProps<{ seg: RenderSegment }>();

const mircPalette = useMircPalette();

const revealed = ref(false);
function reveal(e: Event): void {
  if (revealed.value) return;
  // While hidden, swallow the event so revealing a spoiler embedded in a
  // clickable row (e.g. a search result that jumps to the message on click)
  // doesn't also fire the row's handler. Once revealed it's plain text again
  // and lets clicks through.
  e.stopPropagation();
  revealed.value = true;
}

// mIRC 01 is the canonical spoiler pair (`\x0301,01`) — it's what Lurker's own
// applySpoilerMarkup emits, and what most clients/scripts use. It means "hide
// this", not "paint this black", so it is NOT a colour intent to preserve: a
// black box and black revealed text is nobody's styling choice, it's an artifact
// of the invisibility convention.
//
// This guard was introduced when slot 1 resolved to var(--bg), which made the
// box the exact colour of the page and the REVEALED text invisible too. The
// palette no longer does that (slot 1 is a literal #000000), so removing this
// would now produce a merely ugly black spoiler rather than an unreadable one —
// still wrong, just less dramatically.
const SPOILER_CONVENTION_COLOR = 1;

// Resolve the sender's chosen mIRC colour to a CSS value. Null when there's no
// colour to honour — an absent fg (older snapshots without the field) or the
// convention colour above — and we fall back to the neutral gray box.
const color = computed(() => {
  const fg = props.seg.fg;
  if (fg == null || fg === SPOILER_CONVENTION_COLOR) return null;
  return mircColor(fg, mircPalette.value);
});

const wrapperStyle = computed<CSSProperties>(() => {
  const c = color.value;
  if (!c) {
    // No chosen colour to honour (out-of-range mIRC index, or a RenderSegment
    // hand-built without fg). Keep the wrapper inheriting the .spoiler base
    // background (var(--fg-muted)) unrevealed, then fade to the neutral tint
    // on reveal — same behaviour as before customisation.
    return revealed.value
      ? { background: 'color-mix(in srgb, var(--fg-muted) 22%, transparent)' }
      : {};
  }
  return revealed.value
    ? // Faint tint of the chosen colour so the affordance survives the reveal.
      { background: `color-mix(in srgb, ${c} 22%, transparent)` }
    : { background: c };
});

// The spoiler run still carries any bold/italic/underline/strike toggles that
// were active — apply them so the revealed text matches how it was sent. Once
// revealed, the text takes the chosen colour against the faded backdrop.
const bodyStyle = computed<CSSProperties>(() => {
  const s: CSSProperties = {};
  if (revealed.value && color.value) s.color = color.value;
  if (props.seg.bold) s.fontWeight = 'bold';
  if (props.seg.italic) s.fontStyle = 'italic';
  const decos: string[] = [];
  if (props.seg.underline) decos.push('underline');
  if (props.seg.strike) decos.push('line-through');
  if (decos.length) s.textDecoration = decos.join(' ');
  return s;
});
</script>

<style scoped>
.spoiler {
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  /* Wrapper-style overrides this for coloured spoilers; the var(--fg-muted)
     fallback covers older snapshots whose segments lack fg. */
  background: var(--fg-muted);
  transition: background-color 0.1s ease;
}
.spoiler:not(.revealed) {
  cursor: pointer;
}
.spoiler:not(.revealed) .spoiler-body {
  color: transparent;
  /* Stop a drag-select from revealing the text — click is the only reveal. */
  user-select: none;
}
/* Hover affordance is desktop-only: on touch devices, sticky-:hover would
   make the first tap apply the hover state instead of revealing, so we skip
   the hover rule entirely and let the single tap reveal. We brighten via
   `filter` rather than overriding `background` because the wrapper's inline
   style (chosen mIRC colour) would otherwise win the cascade. */
@media (hover: hover) and (pointer: fine) {
  .spoiler:not(.revealed):hover {
    filter: brightness(1.2);
  }
}
.spoiler:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
</style>
