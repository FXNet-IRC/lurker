// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../../shared/urlPattern.js';
import { mediaKindForUrl } from './uploadHostMatch.js';
import { parseIrcFormatting, trimTrailingPunctuation } from './nickColor.js';

/**
 * Cap on CARDS per message.
 *
 * Slack allows five, halloy defaults to one. Three is enough for a message genuinely sharing
 * a few links, and short of enough for one message to take over a screen. Each card costs
 * real vertical space, so this one has to stay tight.
 */
export const MAX_CARDS_PER_MESSAGE = 3;

/**
 * Cap on MEDIA per message — deliberately generous.
 *
 * Media doesn't cost vertical space the way a card does: two or more images render as one
 * horizontally-scrolling strip of fixed height, so the tenth image costs exactly as much
 * screen as the second. And clicking any of them opens the lightbox as a GALLERY over the
 * whole strip, so nothing is unreachable.
 *
 * A limit still exists, because a message carrying fifty image URLs is spam and each one is
 * an outbound fetch on the server's behalf. It's set high enough not to bind on anything a
 * person would actually post.
 */
export const MAX_MEDIA_PER_MESSAGE = 20;

export interface PreviewToggles {
  inlineMedia: boolean;
  linkPreviews: boolean;
}

/**
 * Which URLs in a message body are worth asking the server about.
 *
 * The two toggles select different URLs, which is the whole reason they're two
 * settings: inline media covers links that ARE a file, link previews cover links
 * to a page. With both off this returns an empty array without touching the
 * network — that's what makes the features genuinely free when disabled.
 *
 * ⚠ The extension test here is a HINT, not a verdict. It decides which setting
 * would cover a URL and therefore whether to bother asking; the server answers
 * authoritatively from Content-Type, and the render path re-checks that answer
 * against the settings. Guessing wrong costs one wasted resolve, never a render
 * the user switched off.
 *
 * ⚠⚠ Runs through the IRC formatting parser rather than over the raw wire text, for two
 * reasons that both bite. A URL inside a SPOILER run must not be resolved at all — the
 * renderer (nickColor's `toRenderSegments`) deliberately skips URL splitting there so a link
 * can't leak hidden content, and unfurling one renders the target full-size next to the
 * click-to-reveal box, which defeats the spoiler completely. And formatting codes live INSIDE
 * the matched token otherwise: `\x03` on the end of a URL was being sent to the resolver as
 * part of the address.
 */
export function previewableUrls(
  text: string | null | undefined,
  { inlineMedia, linkPreviews }: PreviewToggles,
): string[] {
  if (!inlineMedia && !linkPreviews) return [];
  if (!text) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  let mediaCount = 0;
  let cardCount = 0;

  for (const run of parseIrcFormatting(text)) {
    // Same test the renderer uses for the IRC spoiler convention: a run whose foreground and
    // background are the same colour is invisible text.
    if (run.fg != null && run.bg != null && run.fg === run.bg) continue;

    for (const match of run.text.matchAll(createUrlRegex())) {
      const raw = match[0];
      // The shared pattern also matches bare `www.` hosts and email addresses.
      // Neither is fetchable as written, and we are emphatically not resolving
      // somebody's email address.
      if (!/^https?:\/\//i.test(raw)) continue;

      // ⚠ The LINKIFIER's trimmer, deliberately shared rather than re-expressed. The old
      // regex stripped closing brackets unconditionally while the anchor-building path is
      // balance-aware, so `…/wiki/Rust_(programming_language)` was resolved a character short
      // of the URL the user actually clicks: the card silently never appeared, and the 404 was
      // cached for an hour under a string appearing nowhere in the message. Two parsers
      // disagreeing about where a URL ends is the bug; one parser is the fix.
      const url = trimTrailingPunctuation(raw);
      if (!url || seen.has(url)) continue;

      // Three-way, not two. `mediaKindForUrl` returns null both for "definitely a page" and
      // for "no extension to judge by" — and collapsing those meant an extensionless image
      // host (imgur, twimg) could never render for someone who enabled ONLY inline media,
      // permanently, since priming is ingest-driven. Unknowns are charged to the CARD budget,
      // which is the tight one, so honouring them can't turn a link-heavy message into twenty
      // speculative fetches.
      const isMedia = mediaKindForUrl(url) !== null;
      const wanted = isMedia ? inlineMedia : linkPreviews || inlineMedia;
      if (!wanted) continue;
      if (isMedia ? mediaCount >= MAX_MEDIA_PER_MESSAGE : cardCount >= MAX_CARDS_PER_MESSAGE)
        continue;

      if (isMedia) mediaCount++;
      else cardCount++;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
