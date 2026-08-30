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

// Resolve the sender's chosen mIRC colour to a CSS value. Null only when there
// is no colour at all to honour — an absent fg, i.e. an older snapshot from
// before the field existed — and then we fall back to the neutral gray box.
//
// Slot 1 used to be excluded here, on the reasoning that `\x0301,01` is the
// canonical spoiler convention and therefore means "hide this" rather than
// "paint this black". True of a spoiler; false of ASCII art, which uses exactly
// the same encoding to fill a solid black block. The wire bytes cannot tell the
// two apart, and substituting gray guesses wrong on the art — visibly, since it
// recolours part of a picture.
//
// So we honour whatever the sender named, and let the REVEAL carry the safety
// (see bodyStyle).
//
// What makes that affordable is that the affordance is now the SENDER's problem
// rather than the renderer's: applySpoilerMarkup emits grey on grey (14,14),
// the one mono slot that reads as a box on both canvases (4.1:1 dark, 3.7:1
// light), so every spoiler Lurker sends looks right without anyone here
// second-guessing a colour. A spoiler that arrives as 01,01 from another client
// is drawn honestly and is a poor affordance in dark mode — 1.3:1 — but it
// still reveals on click, and that beats repainting somebody's ASCII art.
const color = computed(() => {
  const fg = props.seg.fg;
  if (fg == null) return null;
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
// were active — apply them so the revealed text matches how it was sent.
//
// ⚠ Revealed text sets NO colour, deliberately: it inherits the ordinary
// message colour and is therefore always readable. It used to take the sender's
// colour, which reads nicely for a red spoiler and is unreadable for the two
// that matter most — black revealed on the dark canvas, white on the light one,
// both against a faint tint of themselves. A reveal that reveals nothing is the
// one failure this component cannot have, and it is not worth a tinted word.
// The faded backdrop still marks the run as having been hidden.
const bodyStyle = computed<CSSProperties>(() => {
  const s: CSSProperties = {};
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
  /* ⚠ NO HORIZONTAL padding and NO border-radius, and don't add either back. An
     fg==bg run is not always a spoiler — ASCII art uses the same encoding to
     fill a solid block of colour — so this box has to be able to BE a block.
     Horizontal padding widened the run past its own characters and sheared
     everything after it off the monospace grid; the radius notched its corners,
     which shows wherever two filled runs meet and on any square area an artist
     drew.

     The VERTICAL padding below is the opposite case and is load-bearing: on a
     non-replaced inline element it paints without affecting line-box height, so
     it closes the gap between stacked rows and the grid is untouched. The two
     axes genuinely behave differently here — see --mirc-bg-bleed. */
  padding: var(--mirc-bg-bleed) 0;
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
