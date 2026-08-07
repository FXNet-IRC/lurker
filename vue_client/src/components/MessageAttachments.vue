<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div v-if="visible.length" class="attachments">
    <!-- Two or more images/videos become one horizontally-scrolling row rather than a
         vertical stack, following Slack. Three portrait screenshots stacked is most of a
         screen of somebody else's message; as a strip it's one glance.

         The row's height is ALSO the sizing win: it comes from the server's dimensions, so
         it's known before a single byte of image data arrives, and it's ONE height for the
         whole group instead of N unknown ones. -->
    <div
      v-if="strip.length > 1"
      ref="stripEl"
      class="filmstrip"
      :class="{ 'fade-start': !atStart, 'fade-end': !atEnd }"
      :style="{ height: `${stripHeight}px` }"
      @scroll.passive="updateEdges"
    >
      <MessageAttachment
        v-for="item in strip"
        :key="item.url"
        :preview="item"
        in-strip
        @measured="$emit('measured')"
        @activate="openStripAt(item)"
      />
    </div>
    <MessageAttachment
      v-for="item in stacked"
      :key="item.url"
      :preview="item"
      @measured="$emit('measured')"
      @activate="openSingle(item)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import { previewableUrls, MAX_CARDS_PER_MESSAGE } from '../utils/previewUrls.js';
import {
  useLinkPreview,
  usePreviewsSettled,
  type LinkPreview,
} from '../composables/useLinkPreview.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import MessageAttachment from './MessageAttachment.vue';

// Owns the ARRANGEMENT of a message's attachments; MessageAttachment owns how any one of
// them looks. That split is what makes grouping possible at all — while each child resolved
// its own preview, nothing was in a position to know that a message had three images and
// could lay them out as a row.
//
// Reads are pure (see composables/useLinkPreview): resolution happens at message ingest, so
// nothing here triggers a fetch no matter how often it re-renders.
const props = defineProps<{ text: string | null | undefined }>();

defineEmits<{ measured: [] }>();

const settings = useSettingsStore();
const config = useConfigStore();
const viewer = useMediaViewer();

/** Row heights for a strip, picked by the group's dominant orientation.
 *
 *  Slack effectively has two, and it's the right simplification: it means a message list has
 *  a small, known set of possible attachment heights instead of one per image. Portrait gets
 *  more room because a tall photo squeezed into a landscape row is unreadable — but only a
 *  little more, or one message wins the screen. */
const STRIP_LANDSCAPE = 200;
const STRIP_PORTRAIT = 300;

// ⚠ ANDed with the instance feature flag. A stored `true` from an instance that had the feature
// on must not render anything on one that doesn't — the routes aren't even mounted there, so a
// preview could never resolve and the setting rows aren't shown either. One choke point, so the
// render path and the priming path can't disagree.
const toggles = computed(() => ({
  inlineMedia: config.linkPreviews && settings.effective('chat.inline_media.enabled') === true,
  linkPreviews: config.linkPreviews && settings.effective('chat.link_previews.enabled') === true,
}));

const urls = computed(() => previewableUrls(props.text, toggles.value));

// One ref per URL, read-only. `useLinkPreview` on a URL nobody primed returns a permanently
// null ref, which is exactly the "render nothing" case.
const entries = computed(() => urls.value.map((url) => useLinkPreview(url)));

// ─── Atomic reveal ────────────────────────────────────────────────────────────
//
// A message shows NONE of its attachments until every URL in it has an answer, then the whole
// block appears at once.
//
// The rule this serves: no layout may depend on WHEN A SIBLING RESOLVES. Deriving the
// arrangement from the resolved set meant a message with three images, one of which was already
// cached from an earlier post, painted as a lone image (natural aspect, `max-height: 240px`) and
// then re-arranged into a 200px filmstrip when the other two landed — and `stripHeight` re-picked
// portrait-vs-landscape as the mix changed, a 100px collapse mid-read. Both are sibling-timing
// dependencies, and both are invisible to a scrolled-up reader's re-pin because the growth has
// already happened by the time anything hears about it.
//
// ⚠ Deciding the arrangement from the URL list instead was considered and does NOT work:
// `mediaKindForUrl` charges extensionless hosts to the CARD budget (previewUrls.ts), so an imgur
// or twimg link — the common case on IRC — is predicted as a card and flips to a strip when it
// resolves as an image. The prediction is wrong exactly where it matters.
//
// What this deliberately does NOT cost: a preview's own descriptor arrives atomically with the
// decision to render it, so there is no earlier layout for it to disturb. `STRIP_PORTRAIT` stays,
// and a lone image keeps `object-fit: contain` at its natural aspect.
//
// Two residuals, both deliberate, both stated so a later reader doesn't take them for oversights:
//
//   1. A short-TTL failure that RECOVERS on a re-ask grows the block, and can re-arrange it (one
//      image becoming two is a strip). Holding the gate for it instead would hide a whole message
//      for up to five minutes on the strength of one saturated fetch, which is far worse. The
//      growth goes through `previewRevision`, so it is compensated; only its arrangement isn't.
//      ⚠ The gate cannot RE-CLOSE for this: `flush` writes the answer into the ref before it
//      branches on status, so a transient `unavailable` carries a value, and nothing ever writes
//      null back to a cached ref. The only way a settled URL becomes pending again is cache
//      eviction followed by a re-prime against a fresh ref — which is why `shown` latches.
//   2. A message mixing an image with a slow PAGE link shows nothing until the page answers, and
//      that can be tens of seconds. The page URL cannot be excluded from the gate: an
//      extension-less URL might itself resolve as an image and belong in the arrangement, so
//      "what could render" is not knowable before the answer. This is the trade atomic reveal
//      makes — late but stable, rather than early and re-arranging.
//
// ⚠⚠ Asked, never timed. The first version of this gate revealed on a 1500ms deadline, on the
// reasoning that a message's URLs all land in one batch "~24ms after ingest" — which was the
// coalescing debounce (`FLUSH_MS`) mistaken for the round trip. The server allows 10s of queue
// wait plus a 30s resolve deadline per URL and answers a slice with one `Promise.all`, so the
// deadline fired on any cold link and revealed a PARTIAL set: a lone image that then became a
// filmstrip when the straggler landed, which is verbatim the defect above. `usePreviewsSettled`
// asks the module that actually knows, so there is no latency to guess at and no partial reveal
// to recover from.
const settled = usePreviewsSettled(urls);

/**
 * The URLs this message has already committed to showing.
 *
 * ⚠⚠ A PER-URL latch, not a per-component boolean, and the difference is a defect. The boolean
 * had to be re-derived whenever `urls` changed — otherwise a settings flip grew the set under an
 * already-open latch and the new images painted one at a time — and re-deriving it meant
 * `revealed = settled`, which could go true→false and tear the whole block down. Enabling inline
 * media with ten resolved cards on screen therefore collapsed all ten, buffer-wide, in one frame:
 * ~1200px of uncompensated shrink, for a setting that has nothing to do with cards.
 *
 * A set only ever grows. New URLs stay hidden until the whole set settles, which is the property
 * the gate exists for; anything already painted stays painted, which is the property the latch
 * exists for.
 *
 * ⚠⚠ Watches `urls` AS WELL, and watching `settled` alone was a bug. Vue runs a watcher when its
 * source's VALUE changes, so a flip that admits a URL which is ALREADY resolved — the same image
 * posted earlier in the session, or previewed in another buffer — left `settled` true before and
 * true after. The watcher never ran, the URL was never admitted, and its attachment stayed hidden
 * for the life of the row with everything about it resolved and ready.
 *
 * The array identity churns on any settings write (`urls` allocates a fresh array each
 * evaluation), so this fires more often than it strictly needs to. That is harmless HERE and was
 * not in the version this replaced: the callback only ever ADDS, and re-adding a URL already in
 * the set changes nothing, so no spurious render can follow. The defect before was a callback
 * that could REMOVE.
 */
const shown = ref<ReadonlySet<string>>(new Set());
watch(
  [settled, urls],
  ([ok]) => {
    if (!ok) return;
    const next = new Set(shown.value);
    for (const url of urls.value) next.add(url);
    if (next.size !== shown.value.size) shown.value = next;
  },
  { immediate: true },
);

/**
 * Previews that are resolved AND allowed by the settings.
 *
 * Re-checked against the server's answer rather than the extension guess that prompted the
 * request: an extensionless URL that turns out to be a PNG is inline media, and a `.jpg` that
 * redirects to an HTML login page is not. Otherwise "link previews off" could still be talked
 * into rendering a card.
 */
const visible = computed<LinkPreview[]>(() => {
  const out: LinkPreview[] = [];
  let cards = 0;
  for (const entry of entries.value) {
    const p = entry.value;
    if (!p || p.status !== 'ok') continue;
    // All-or-nothing, per URL: see `shown` above.
    if (!shown.value.has(p.url)) continue;
    const isMedia = p.kind === 'image' || p.kind === 'video' || p.kind === 'audio';
    if (isMedia ? !toggles.value.inlineMedia : !toggles.value.linkPreviews) continue;
    // ⚠ The card cap is re-applied to the SERVER's answer, not just to the extension guess that
    // prompted the request. `previewableUrls` charges anything that looks like media to the
    // generous media budget (20), so twenty image-looking URLs that all resolve as pages —
    // extensionless CDN links, a `.png` that redirects to an HTML login page — arrived as twenty
    // stacked cards and took over the screen. The tight cap exists because a card costs real
    // vertical space, and only the resolved kind knows whether one is being built.
    if (!isMedia) {
      if (cards >= MAX_CARDS_PER_MESSAGE) continue;
      cards++;
    }
    out.push(p);
  }
  return out;
});

/** Strip candidates: pictures and video, which read as a row. Audio doesn't — a row of
 *  transport controls is not a gallery — so it stays stacked and full-width. */
const strip = computed(() => visible.value.filter((p) => p.kind === 'image' || p.kind === 'video'));

/** Everything the strip didn't take. A lone image renders on its own, at its own size: it's
 *  the common case and a one-item strip would only make it smaller for no reason. */
const stacked = computed(() =>
  strip.value.length > 1 ? visible.value.filter((p) => !strip.value.includes(p)) : visible.value,
);

/**
 * Open the lightbox over the WHOLE strip, positioned on the image that was clicked.
 *
 * This is what makes a generous media cap safe: however many images a message carries, every
 * one of them is reachable by arrowing through the viewer rather than only by scrolling the
 * strip. The viewer has always been a gallery — a single file is a gallery of one — so this
 * needed no work there.
 */
/**
 * ⚠ The viewer gets `src` — OUR proxy path — never the origin URL.
 *
 * Handing it `preview.url` broke the promise the setting makes in so many words ("the file is
 * fetched and served by your Lurker server, so the site hosting it never sees your device"):
 * the image rendered inline through the proxy, and then clicking it went straight to the remote
 * host. It also meant an `http://` image displayed fine inline but was blocked as mixed content
 * once the lightbox loaded it directly, so the click produced a dead "open in browser" card.
 */
function openStripAt(item: LinkPreview): void {
  // ⚠ IMAGES only. MediaViewerModal derives which element to render from the URL's extension,
  // and a proxy path has none — `mediaKindForUrl` even throws on a relative URL and returns
  // null — so it falls back to `image` and would mount a <video>'s bytes in an <img>, producing
  // the "open in browser" failure card for a file that plays fine inline. A video in a strip has
  // its own inline controls anyway; it isn't a lightbox item.
  const gallery = strip.value.filter((p) => p.kind === 'image');
  // `shareUrl` carries the ORIGIN address alongside the proxy path we render, so "copy link"
  // hands over something another person can actually open.
  const items = gallery.map((p) => ({ url: p.src ?? p.url, shareUrl: p.url }));
  const at = gallery.indexOf(item);
  if (at === -1) return;
  viewer.openGallery(items, at);
}

function openSingle(item: LinkPreview): void {
  viewer.openGallery([{ url: item.src ?? item.url, shareUrl: item.url }], 0);
}

// ─── Scroll affordance ────────────────────────────────────────────────────────
//
// A strip that scrolls has to LOOK like it scrolls, or the images past the edge simply don't
// exist as far as the reader is concerned. The fade is applied with `mask-image`, so the
// content itself dissolves at the boundary rather than having a gradient laid over it — which
// means it works on any background, including the highlight tint, with nothing to keep in sync.
//
// Only faded on a side that can actually move. A permanent fade would be a lie in both
// directions: it implies more content when the strip is fully scrolled, and it dims the first
// image for no reason when there's nothing to the left.
const stripEl = useTemplateRef<HTMLElement>('stripEl');
const atStart = ref(true);
const atEnd = ref(true);

function updateEdges(): void {
  const el = stripEl.value;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  // A pixel of slack: fractional scroll positions and sub-pixel layout mean an exact
  // comparison flickers the fade on and off at the extremes.
  atStart.value = el.scrollLeft <= 1;
  atEnd.value = el.scrollLeft >= max - 1;
}

// The strip's scrollable width changes without it being scrolled — the window resizes, images
// finish laying out, a re-render swaps the group. One observer catches all of those, including
// the initial measurement, which is why there's no separate onMounted call.
// ⚠ Re-runs when the strip's CONTENTS change, not only when the element itself is swapped. The
// children were enumerated once, so a strip that gained an item — a later preview resolving into
// a group that was already on screen — kept observing the old set and never re-measured. Its
// `atEnd` then stayed true while there was now something to scroll to, and the fade that
// advertises it silently stopped appearing. `flush: 'post'` so the new children exist to observe.
let observer: ResizeObserver | null = null;
watch(
  [stripEl, strip],
  () => {
    observer?.disconnect();
    observer = null;
    const el = stripEl.value;
    if (!el) return;
    observer = new ResizeObserver(() => updateEdges());
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    updateEdges();
  },
  { flush: 'post' },
);
onBeforeUnmount(() => observer?.disconnect());

const stripHeight = computed(() => {
  const portrait = strip.value.filter((p) => (p.thumbHeight ?? 0) > (p.thumbWidth ?? 0)).length;
  // "Primarily portrait" rather than "any portrait": one tall image among four wide ones
  // shouldn't make the whole row tall.
  return portrait * 2 > strip.value.length ? STRIP_PORTRAIT : STRIP_LANDSCAPE;
});
</script>

<style scoped>
.attachments {
  display: flex;
  flex-direction: column;
  /* NOT the default `stretch`. A flex column stretches its children across the cross axis,
     which forced every inline image to the container's full width while `max-height` capped
     its height — squashing it instead of scaling it. */
  align-items: flex-start;
  gap: var(--space-2);
  /* Breathing room on BOTH sides. The bottom margin matters more than it looks: without it an
     image or card sits flush against the next author's name, and the attachment reads as
     belonging to the message below it rather than the one above. */
  margin-top: var(--space-2);
  margin-bottom: var(--space-4);
  /* No width cap HERE. The cap belongs to the card (below), not to the container: a strip
     scrolls, so capping it at card width would mean two images visible out of five for no
     reason other than that cards need a limit. */
  max-width: 100%;
  min-width: 0;
}
/* A card wants the width it's given — its text has to wrap against something — but not the
   full width of a wide window, where it stops reading as part of the message and starts
   reading as a page element. */
.attachments > :deep(.card) {
  align-self: stretch;
  max-width: 480px;
}

.filmstrip {
  display: flex;
  gap: var(--space-2);
  /* The strip scrolls itself; the message list must never scroll sideways. */
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  /* Height comes from the inline style — one known value for the whole group. */
  align-items: stretch;
  /* No visible scrollbar: it would eat into a height that's deliberately fixed, and change the
     strip's height depending on the platform's scrollbar style. The fade is the affordance. */
  scrollbar-width: none;
  /* Snap so a flick lands on an image rather than halfway across one. `proximity` rather than
     `mandatory` — mandatory fights a deliberate small drag. */
  scroll-snap-type: x proximity;
}
.filmstrip::-webkit-scrollbar {
  display: none;
}
/* ⚠ Targets the media itself, not the direct child. An inline image is wrapped in a
   `display: contents` span (see MessageAttachment), which generates no box — so a snap point on
   the direct child would have nothing to align. */
.filmstrip :deep(.inline-image),
.filmstrip :deep(.inline-video) {
  scroll-snap-align: start;
}

/* The fade, as a mask on the content rather than a gradient laid over it — so it works on any
   background (including the highlight tint) with nothing to keep in sync.
   The three cases are spelled out rather than composited, because `mask-composite` for the
   both-sides case is more machinery than three declarations. */
.filmstrip.fade-end {
  mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent 100%);
}
.filmstrip.fade-start {
  mask-image: linear-gradient(to right, transparent 0, #000 40px);
}
.filmstrip.fade-start.fade-end {
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 40px,
    #000 calc(100% - 40px),
    transparent 100%
  );
}
</style>
