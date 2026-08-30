<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="attachments">
    <!-- Two or more images become one MOSAIC: a two-column grid of fixed-size cells, each image
         cropped to fill its cell.

         ⚠⚠ This replaced a horizontally-scrolling filmstrip, and the reason is the interaction
         rather than the look. A sideways scroller inside a vertically-scrolling list is a
         gesture conflict on touch — a diagonal drag has to be arbitrated, and the loser is
         whichever one the reader meant — and it hides content behind an affordance (a mask
         fade) that has to be measured, observed and kept in sync. The mosaic shows everything at
         once, needs no scroll container, no ResizeObserver and no fade.

         It keeps the property the strip was built for: the group's height is a function of the
         IMAGE COUNT alone — ceil(n / 2) rows of a fixed height — so no descriptor and no
         late-arriving byte can change it. Nothing here reads a dimension. Cropping is what buys
         that, and cropping is recoverable because any cell opens the whole set in the viewer.

         The shape rule, for any count: EVEN → all pairs; ODD → the three-up block (one
         full-height picture beside two stacked) first, then pairs. So 3 is hero-and-two, 4 is
         2x2, 5 is the three-up plus a pair, 7 the three-up plus two pairs. One rule, no holes at
         any count, and the odd block LEADS — a trailing full-width tile crops a landscape photo
         hard and makes the last picture the subject of the message. It is one CSS declaration:
         the first tile spans two rows when the count is odd, and auto-placement flows everything
         after it into pairs around the tall cell. Ported from lurker-ios, whose
         MessageAttachmentsView draws the same rule with stack views. -->
    <div v-if="mosaic.length" class="mosaic" :class="{ odd: mosaic.length % 2 === 1 }">
      <div v-for="item in mosaic" :key="item.url" class="tile">
        <MessageAttachment
          :preview="item"
          tiled
          @measured="$emit('measured')"
          @activate="openAt(item)"
        />
      </div>
    </div>
    <MessageAttachment
      v-for="item in stacked"
      :key="item.url"
      :preview="item"
      @measured="$emit('measured')"
      @activate="openAt(item)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import MessageAttachment from './MessageAttachment.vue';

/**
 * The ARRANGEMENT of one message's attachments; MessageAttachment owns how any one of them
 * looks, and MessageBody owns which of them exist.
 *
 * ⚠ Purely presentational — it receives an already-resolved, already-latched, already-permitted
 * list. It used to take the message TEXT and derive all of that itself, and it cannot any more:
 * the body's text needs the same resolved set in order to drop a URL whose image is on screen,
 * and two components deriving one fact is the defect class this feature keeps producing. The
 * derivation moved up to MessageBody; this renders what it is handed.
 */
const props = defineProps<{ previews: LinkPreview[] }>();

defineEmits<{ measured: [] }>();

const viewer = useMediaViewer();

/**
 * Every image in the message, in order.
 *
 * ⚠ IMAGES only, and video is the deliberate omission — but no longer for the reason this
 * comment used to give. The old hazard was that MediaViewerModal derives its element from the
 * URL's extension, a proxy path has none, and a video handed to it mounted MP4 bytes in an
 * `<img>`. That cannot arise now: the server mints no `src` for video or audio at all, so there
 * are no bytes to hand anywhere. The filter stays because the mosaic is a grid of PICTURES, and
 * a file card is not one.
 *
 * ⚠ It is also why video and audio are never mosaic tiles. They render as full-width file cards
 * (see MessageAttachment), and a card cropped into a grid cell loses the text that is the whole
 * of it.
 */
const images = computed(() => props.previews.filter((p) => p.kind === 'image'));

/**
 * The tiles, which are now EVERY image in the message. A lone image is not a one-cell mosaic —
 * see `stacked`.
 *
 * ⚠⚠ There used to be a four-cell cap with a `+N` count on the last tile, and dropping it is
 * lurker#773. The cap's stated reason was that a fifth image "either adds a row, and a message's
 * height stops being a small known set, or shrinks every cell". Only the first half was ever
 * true, and it was never the property that mattered: what keeps the block byte-independent is
 * that its height is a function of the COUNT — ceil(n / 2) fixed rows — not that the count of
 * possible heights is small. The real bound on a message taking over the screen is
 * `MAX_MEDIA_PER_MESSAGE` (20), which is enforced before any of this. A badge was also a worse
 * bargain than it looked: it advertises pictures as hidden while the whole point of the grid is
 * that everything in the message is on screen at once.
 */
const mosaic = computed(() => (images.value.length > 1 ? images.value : []));

/**
 * Everything the mosaic didn't take: cards, video, audio — and a lone image, which renders on its
 * own at its own size. That last case is the common one, and a one-cell mosaic would only crop it
 * for no reason.
 *
 * ⚠ Subtract the mosaic's own set, and let it be empty when there is no mosaic — otherwise a
 * single image is spoken for by a grid that was never drawn and the message renders no picture
 * at all. When the cap existed this had to subtract every image the mosaic STOOD IN FOR rather
 * than the tiles it drew, or the overflow rendered a second time underneath at full size; with
 * no cap the two sets are the same and the trap is gone with it.
 *
 * ⚠ The tests could not see that one: they counted `.mosaic .tile`, which was correct the whole
 * time, and never the total number of images in the block. Counting what you capped is not the
 * same as counting what rendered — so the suite still asserts the total.
 */
const stacked = computed(() => {
  const inMosaic = new Set<LinkPreview>(mosaic.value);
  return props.previews.filter((p) => !inMosaic.has(p));
});

/**
 * Open the viewer over EVERY image in the message, positioned on the one that was clicked.
 *
 * ⚠ The gallery is `images` — every picture in the message, mosaic or not — and that is what
 * makes the crop safe: a tile shows the middle of a photograph, and clicking it shows the
 * photograph. A lone image is a gallery of one, which the viewer has always handled.
 *
 * ⚠ The viewer gets `src` — OUR proxy path — never the origin URL. Handing it `preview.url` broke
 * the promise the setting makes in so many words ("the file is fetched and served by your Lurker
 * server, so the site hosting it never sees your device"): the image rendered inline through the
 * proxy, and then clicking it went straight to the remote host. It also meant an `http://` image
 * displayed fine inline but was blocked as mixed content once the lightbox loaded it directly.
 * `shareUrl` carries the ORIGIN address alongside, so "copy link" hands over something another
 * person can actually open.
 */
function openAt(item: LinkPreview): void {
  // ⚠ Video and audio open on the ORIGIN url — the exact inverse of the image rule below, and
  // both spellings are the media policy. An image renders unasked, so its bytes must come
  // through us; a clip plays only on this deliberate click, and the click goes straight to the
  // origin because relaying deliberate playback is the relay the policy retired. A gallery of
  // one: the arrow-through set is pictures, and a player in a picture gallery is a mode switch.
  if (item.kind === 'video' || item.kind === 'audio') {
    // ⚠ Pass the SERVER's kind: the viewer would otherwise guess it from the URL extension
    // and open an extensionless clip as a broken <img>. The origin url, per the media policy.
    viewer.open(item.url, item.kind);
    return;
  }
  const gallery = images.value;
  const at = gallery.indexOf(item);
  if (at === -1) return;
  viewer.openGallery(
    gallery.map((p) => ({ url: p.src ?? p.url, shareUrl: p.url })),
    at,
  );
}
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
  max-width: 100%;
  min-width: 0;
}
/* The top margin separates an attachment from the text above it. On a body whose every URL was
   hidden there is no text above it — MessageBody sets this class, and MessageList's `:has()`
   companion top-aligns the row's nick for the same reason.

   ⚠⚠ It does NOT follow that the gap goes to zero, and for two commits it did (lurker#773): an
   image-only message sat flush against the top edge of its row, so a hovered, alt-striped or
   highlighted row painted its background right up to the picture while every text row kept a
   sliver of it. What it gets instead is `--space-4` — the SAME value as the bottom margin below,
   because with no text in the row the picture is the whole of it and an even inset top and bottom
   is what makes it sit inside the row rather than at the top of it. Half-leading (`--space-2`,
   what a 1.55 line-height puts above a text row's first glyph) was tried first, on screen, and
   reads as too little against 8px underneath. It REPLACES the separation margin rather than
   adding to it — the text-then-image case already has its gap and would otherwise get 12px.

   ⚠ It lives HERE rather than beside that `:has()` companion because a scoped rule in MessageList
   cannot reach this element: MessageBody is a multi-root fragment, so MessageList's scope id
   never propagates onto `.attachments`. The rule was written there first and did nothing at all. */
.attachments.body-only {
  margin-top: var(--space-4);
}
/* A card wants the width it's given — its text has to wrap against something — but not the
   full width of a wide window, where it stops reading as part of the message and starts
   reading as a page element.
   ⚠ 400 rather than 480, and the CARD is what was narrowed rather than the picture inside it.
   A hero capped below its card's width leaves a band of empty panel down one side, which reads
   as a layout mistake rather than as a smaller image; narrowing the card keeps the picture
   flush to both edges and takes the height down with it (376px of content box at 1200/630 is
   ~197px tall, against ~239px at 480). The square card gets narrower too, which costs its text
   80px of wrapping width it did not need. */
.attachments > :deep(.card) {
  align-self: stretch;
  max-width: 400px;
}

/* ─── The mosaic ──────────────────────────────────────────────────────────────
   Cells from the count, height from the cells. Nothing reads an image's dimensions, so the
   whole grid is laid out correctly before a single byte of any picture arrives — the same
   byte-independence a lone image gets from its reserved box, reached without needing one.

   ⚠ One row height, and every layout is a whole number of rows: ceil(n / 2) of them, so a mosaic
   is 160px, 324px, 488px … and never a value that depends on a picture. That — not the number of
   distinct heights, which the four-cell cap kept at two — is the property the filmstrip's fixed
   height existed to provide, and it survives an uncapped grid unchanged. */
.mosaic {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 160px;
  gap: var(--space-2);
  width: 100%;
  /* Past this the mosaic stops reading as part of a message and starts reading as a page element
     — on a wide window a 2-up grid of full-width cells is a slideshow, not an annotation.
     ⚠ This used to say "matches the card's cap" and no longer does: the card narrowed to 400px
     when the hero band landed, and the mosaic was left at 480. Deliberately NOT changed to match,
     because the two were looked at side by side at these values and approved — but they are now
     two independent dials, so anything claiming they agree is wrong. */
  max-width: 480px;
}
/* An odd count LEADS with the three-up block: a full-height picture beside two stacked ones.
   Discord's arrangement for three, and it is the one that gives an odd count a shape rather than
   a gap — a 2x2 grid with three items leaves a hole, and stretching the third across the bottom
   makes it the subject of the message.

   ⚠⚠ This one declaration is the whole of the "5, 7, 19 images" layout, and that is why the count
   cap could go. Auto-placement does the rest: the tall cell occupies column 1 of the first two
   rows, images 2 and 3 fill column 2 beside it, and every image after that finds the first free
   row and pairs up. Whatever the three-up block doesn't take is even by construction, so no
   count leaves a hole — which is exactly the rule lurker-ios draws with nested stack views.

   ⚠ It keys off ODD, not off `n3`. The class used to be `n${count}` and the selector `.n3`, which
   was correct only because nothing past four was ever drawn; at 5 that spelling silently
   degrades to a 2x2 grid with a hole in it. */
.mosaic.odd > .tile:first-child {
  grid-row: span 2;
}

/* The grid item. The image inside is a `display: contents` wrapper's child (see
   MessageAttachment), so it becomes this element's own child for layout — which is why the
   clipping and the rounding live here rather than on the picture. */
.tile {
  overflow: hidden;
  border-radius: var(--radius-md);
  /* A grid item's automatic minimum is its content, so a wide image would otherwise refuse to
     shrink and push the second column off the row. */
  min-width: 0;
}
</style>
