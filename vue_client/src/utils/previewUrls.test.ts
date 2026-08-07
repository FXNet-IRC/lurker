// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { previewableUrls, MAX_CARDS_PER_MESSAGE, MAX_MEDIA_PER_MESSAGE } from './previewUrls.js';

const BOTH = { inlineMedia: true, linkPreviews: true };
const NEITHER = { inlineMedia: false, linkPreviews: false };
const MEDIA_ONLY = { inlineMedia: true, linkPreviews: false };
const PAGES_ONLY = { inlineMedia: false, linkPreviews: true };

describe('previewableUrls — the toggles', () => {
  it('asks for nothing at all when both settings are off', () => {
    // The load-bearing property of default-off: no work, not even a request
    // that gets discarded.
    expect(previewableUrls('https://e.test/a.png and https://e.test/page', NEITHER)).toEqual([]);
  });

  it('gates the two classes asymmetrically, because only one of them is knowable', () => {
    // `mediaKindForUrl` recognises MEDIA extensions and returns null for everything else — a
    // page, a bare host, an extensionless image alike. So "this is media" is a verdict the
    // client can act on, and "this is not media" never is. Link-previews-off therefore drops a
    // .png outright, while inline-media-off cannot drop an unknown without breaking the
    // extensionless image case below.
    expect(previewableUrls('https://e.test/a.png', PAGES_ONLY)).toEqual([]);
    expect(previewableUrls('https://e.test/a.png', MEDIA_ONLY)).toEqual(['https://e.test/a.png']);
  });

  it('inline media still asks about an EXTENSIONLESS link, because it cannot tell', () => {
    // ⚠ The deliberate trade, and it costs a fetch: with only inline media on, an extensionless
    // URL is asked about even though most turn out to be pages. The alternative is worse —
    // imgur, twimg and every CDN serve images from extensionless paths, so treating "no
    // extension" as "definitely a page" made inline media permanently unable to render the
    // majority of real image links. Bounded by the CARD cap (3), not the media cap, so a
    // link-heavy message can't become twenty speculative fetches. A page that comes back is
    // still not RENDERED — MessageAttachments re-checks the server's answer.
    expect(previewableUrls('https://i.imgur.com/aBcDeF', MEDIA_ONLY)).toEqual([
      'https://i.imgur.com/aBcDeF',
    ]);
    const many = Array.from({ length: 9 }, (_, i) => `https://e.test/p${i}`).join(' ');
    expect(previewableUrls(many, MEDIA_ONLY)).toHaveLength(MAX_CARDS_PER_MESSAGE);
  });

  it('link previews selects pages and ignores file links', () => {
    expect(previewableUrls('https://e.test/a.png https://e.test/article', PAGES_ONLY)).toEqual([
      'https://e.test/article',
    ]);
  });

  it('both on selects both', () => {
    expect(previewableUrls('https://e.test/a.png https://e.test/article', BOTH)).toEqual([
      'https://e.test/a.png',
      'https://e.test/article',
    ]);
  });

  it('treats video and audio links as inline media, not as pages', () => {
    expect(previewableUrls('https://e.test/clip.mp4 https://e.test/song.mp3', MEDIA_ONLY)).toEqual([
      'https://e.test/clip.mp4',
      'https://e.test/song.mp3',
    ]);
    expect(previewableUrls('https://e.test/clip.mp4', PAGES_ONLY)).toEqual([]);
  });
});

describe('previewableUrls — what counts as a URL', () => {
  it('ignores bare www hosts, which are not fetchable as written', () => {
    expect(previewableUrls('see www.example.com for more', BOTH)).toEqual([]);
  });

  it('never resolves an email address', () => {
    // The shared URL pattern matches these; resolving one would be both useless
    // and a small privacy insult.
    expect(previewableUrls('mail me at bob@example.com', BOTH)).toEqual([]);
    expect(previewableUrls('mailto:bob@example.com', BOTH)).toEqual([]);
  });

  it('strips trailing sentence punctuation', () => {
    expect(previewableUrls('go to https://e.test/page.', BOTH)).toEqual(['https://e.test/page']);
    expect(previewableUrls('really? https://e.test/x!', BOTH)).toEqual(['https://e.test/x']);
    expect(previewableUrls('(https://e.test/y)', BOTH)).toEqual(['https://e.test/y']);
  });

  it('keeps a path that legitimately contains punctuation', () => {
    expect(previewableUrls('https://e.test/a.b.c/d', BOTH)).toEqual(['https://e.test/a.b.c/d']);
  });

  it('ends a URL where the LINKIFIER ends it, brackets and all', () => {
    // ⚠ Two parsers disagreeing about where a URL stops is the bug. The anchor the user clicks
    // is built by nickColor's balance-aware trimmer, so stripping ')' unconditionally here
    // resolved a DIFFERENT address than the one in the message: the real page 200s, the
    // clipped one 404s, and that 404 is cached for an hour under a string that appears nowhere
    // in the text. Same helper for both, so they cannot drift.
    const wiki = 'https://en.wikipedia.org/wiki/Rust_(programming_language)';
    expect(previewableUrls(`see ${wiki}`, BOTH)).toEqual([wiki]);
    // ...while a URL merely wrapped in brackets still loses them.
    expect(previewableUrls('(https://e.test/y)', BOTH)).toEqual(['https://e.test/y']);
  });

  it('never resolves a link hidden behind a spoiler', () => {
    // ⚠⚠ The renderer skips URL splitting inside a spoiler run precisely so a link cannot leak
    // the hidden content. Resolving one anyway renders the target full-size as a SIBLING of the
    // click-to-reveal box — the spoiler is defeated by the preview, and for an image the payload
    // is on screen before anyone chooses to reveal it. Only inline media need be on.
    const hidden = '\x0301,01https://secret.example/leak.png\x03';
    expect(previewableUrls(hidden, BOTH)).toEqual([]);
    expect(previewableUrls(hidden, MEDIA_ONLY)).toEqual([]);
    // A visible link in the same message is unaffected.
    expect(previewableUrls(`ok https://e.test/fine.png ${hidden}`, BOTH)).toEqual([
      'https://e.test/fine.png',
    ]);
  });

  it('strips formatting codes out of the URL rather than resolving them', () => {
    // A colour reset immediately after a link put \x03 INSIDE the matched token, so the
    // resolver was handed an address with a control character on the end.
    expect(previewableUrls('\x0304https://e.test/red.png\x03 done', BOTH)).toEqual([
      'https://e.test/red.png',
    ]);
  });

  it('keeps a query string intact', () => {
    expect(previewableUrls('https://e.test/s?q=1&r=2', BOTH)).toEqual(['https://e.test/s?q=1&r=2']);
  });

  it('handles a message that is nothing but a URL', () => {
    expect(previewableUrls('https://e.test/only', BOTH)).toEqual(['https://e.test/only']);
  });

  it('is fine with empty, null, and undefined text', () => {
    expect(previewableUrls('', BOTH)).toEqual([]);
    expect(previewableUrls(null, BOTH)).toEqual([]);
    expect(previewableUrls(undefined, BOTH)).toEqual([]);
  });
});

describe('previewableUrls — limits', () => {
  it('resolves a repeated link only once', () => {
    const text = 'https://e.test/a https://e.test/a https://e.test/a';
    expect(previewableUrls(text, BOTH)).toEqual(['https://e.test/a']);
  });

  it('caps CARDS tightly, because each one costs vertical space', () => {
    const text = Array.from({ length: 12 }, (_, i) => `https://e.test/${i}`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(MAX_CARDS_PER_MESSAGE);
  });

  it('lets many images through, because a strip costs the same at 2 or at 12', () => {
    // Media renders as one horizontally-scrolling strip of fixed height and the lightbox
    // opens as a gallery over the whole thing, so the tenth image costs no more screen than
    // the second and none of them is unreachable.
    const text = Array.from({ length: 12 }, (_, i) => `https://e.test/${i}.png`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(12);
  });

  it('still bounds media, so a spam message is not fifty outbound fetches', () => {
    const text = Array.from({ length: 40 }, (_, i) => `https://e.test/${i}.png`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(MAX_MEDIA_PER_MESSAGE);
  });

  it('counts the two caps independently', () => {
    // Five cards' worth of pages plus five images: the pages are trimmed to three, the
    // images all survive. One class filling up must not consume the other's budget.
    const pages = Array.from({ length: 5 }, (_, i) => `https://e.test/page${i}`);
    const images = Array.from({ length: 5 }, (_, i) => `https://e.test/img${i}.png`);
    const got = previewableUrls([...pages, ...images].join(' '), BOTH);
    expect(got.filter((u) => u.endsWith('.png')).length).toBe(5);
    expect(got.filter((u) => !u.endsWith('.png')).length).toBe(MAX_CARDS_PER_MESSAGE);
  });

  it('counts the cap after deduping, not before', () => {
    // Four mentions of one link plus two others should yield three previews,
    // not one — otherwise a message quoting the same URL twice would silently
    // lose its other links.
    const text = 'https://e.test/a https://e.test/a https://e.test/b https://e.test/c';
    expect(previewableUrls(text, BOTH)).toEqual([
      'https://e.test/a',
      'https://e.test/b',
      'https://e.test/c',
    ]);
  });
});
