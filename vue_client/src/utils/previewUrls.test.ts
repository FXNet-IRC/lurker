// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  previewableUrls,
  hideableUrls,
  segmentsWithoutUrls,
  MAX_CARDS_PER_MESSAGE,
  MAX_MEDIA_PER_MESSAGE,
} from './previewUrls.js';
import { applySpoilerMarkup } from './spoilerMarkup.js';

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

  // The other side of the same test: a run whose matched pair is a slot the palette can't paint
  // is NOT hidden, so its links are ordinary links.
  //
  // ⚠ This is load-bearing rather than academic. `applySpoilerMarkup` closes a spoiler with
  // `\x0399,99` when a digit follows it, so the tail of those messages is a 99,99 run — and
  // skipping it here would silently drop the preview for any URL after such a spoiler. A missing
  // preview traced back to a colour code is not a debugging session anyone should have.
  it('still resolves a link in an unrenderable matched pair, which is not a spoiler', () => {
    expect(previewableUrls('\x0399,99https://e.test/fine.png', BOTH)).toEqual([
      'https://e.test/fine.png',
    ]);
    expect(
      previewableUrls(applySpoilerMarkup('||x||5 then https://e.test/fine.png'), BOTH),
    ).toEqual(['https://e.test/fine.png']);
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

describe('previewableUrls — <angle brackets> suppress a preview', () => {
  it('refuses to resolve a URL the author wrapped in brackets', () => {
    // RFC 3986 Appendix C's delimiter convention, borrowed from Discord as "link, but no unfurl".
    // It is the only per-link control there is — the two settings are all-or-nothing — so a
    // person sharing a URL they don't want unfolded has exactly this and nothing else.
    expect(previewableUrls('<https://e.test/a.png>', BOTH)).toEqual([]);
    expect(previewableUrls('see <https://e.test/article> for more', BOTH)).toEqual([]);
  });

  it('leaves an unbracketed URL in the same message alone', () => {
    expect(previewableUrls('<https://e.test/a.png> https://e.test/b.png', BOTH)).toEqual([
      'https://e.test/b.png',
    ]);
  });

  it('needs BOTH brackets, so a stray one is not a suppression', () => {
    // A `<` in prose is ordinary. Treating a half-open bracket as the convention would silently
    // eat previews in messages that never asked for it.
    expect(previewableUrls('<https://e.test/a.png', BOTH)).toEqual(['https://e.test/a.png']);
    expect(previewableUrls('https://e.test/a.png>', BOTH)).toEqual(['https://e.test/a.png']);
  });

  it('recognises the brackets even when the URL ends in punctuation', () => {
    // ⚠⚠ The end test measures from the UNTRIMMED match. `trimTrailingPunctuation` eats the `.`
    // here, so a check against the trimmed length lands on `.` instead of `>` and the brackets
    // stop working on exactly the URLs whose ends are ambiguous — which is the case the
    // convention exists for.
    expect(previewableUrls('<https://e.test/wiki/Foo.>', BOTH)).toEqual([]);
  });

  it('suppresses only the occurrence that is wrapped', () => {
    // The brackets speak for the occurrence, not for the address: a URL posted bare earlier in
    // the same message still resolves. (Gated BEFORE the dedupe, or the bracketed one would be
    // recorded as `seen` and cancel its own bare twin.)
    expect(previewableUrls('https://e.test/a.png and <https://e.test/a.png>', BOTH)).toEqual([
      'https://e.test/a.png',
    ]);
  });
});

describe('hideableUrls — when the address stops being worth showing', () => {
  const A = 'https://e.test/a.png';
  const B = 'https://e.test/b.png';
  const C = 'https://e.test/c.png';
  const all = (...urls: string[]) => new Set(urls);

  it('hides a URL that is the whole message', () => {
    expect([...hideableUrls(A, all(A))]).toEqual([A]);
  });

  it('hides a URL the message begins or ends with', () => {
    expect([...hideableUrls(`${A} look at this`, all(A))]).toEqual([A]);
    expect([...hideableUrls(`look at this ${A}`, all(A))]).toEqual([A]);
  });

  it('KEEPS a URL with prose on both sides', () => {
    // The rule's whole point. Mid-sentence the address is part of something somebody wrote —
    // "I read $URL and then..." — and deleting it leaves a sentence with a hole in it.
    expect([...hideableUrls(`I read ${A} this morning`, all(A))]).toEqual([]);
  });

  it('hides every URL in a message that is nothing but URLs', () => {
    // ⚠⚠ Case (a), and the reason this is a peel rather than a per-URL edge test. `B` touches
    // neither end of the message; it becomes an edge only once `A` has been taken.
    const got = hideableUrls(`${A} ${B} ${C}`, all(A, B, C));
    expect([...got].sort()).toEqual([A, B, C].sort());
  });

  it('stops peeling at a URL that is NOT a candidate', () => {
    // A page link renders a card and KEEPS its address, so it is not something the peel may step
    // over: anything behind it is still in the middle of the line. Without the candidate test the
    // peel would consume the page as though it were hidden — and, worse, report it as hidden,
    // taking the address off a card that is going to render one.
    //
    // ⚠ Both messages need a blocker at the FAR end, or the other peel reaches the image anyway
    // and the assertion passes for the wrong reason. That is what the first draft of this test
    // got wrong: `${PAGE} ${B}` really does end with the image, so hiding it is correct there.
    const PAGE = 'https://news.example/article';
    expect([...hideableUrls(`${PAGE} ${B} tail`, all(B))]).toEqual([]);
    expect([...hideableUrls(`lead ${B} ${PAGE}`, all(B))]).toEqual([]);
  });

  it('hides a trailing image even when a card precedes it', () => {
    // The flip side of the above, and the reason the peel is per-end: the message still ENDS with
    // the picture, so its address is still a duplicate of what the reader is looking at.
    const PAGE = 'https://news.example/article';
    expect([...hideableUrls(`${PAGE} ${B}`, all(B))]).toEqual([B]);
  });

  it('peels from both ends independently', () => {
    // Leading and trailing images hide; the one buried in the prose does not.
    const text = `${A} some words ${B} more words ${C}`;
    const got = hideableUrls(text, all(A, B, C));
    expect([...got].sort()).toEqual([A, C].sort());
  });

  it('does not count a spoiler run as whitespace', () => {
    // ⚠ Spoiler runs contribute no URLs (a hidden link must never be resolved) but their TEXT
    // still occupies the line. Ignoring it entirely would make a URL that follows a spoiler look
    // like the start of the message and take its address away from under the reveal box.
    const text = `${applySpoilerMarkup('psst')} ${A}`;
    expect([...hideableUrls(text, all(A))]).toEqual([A]);
    const buried = `${applySpoilerMarkup('psst')} ${A} tail`;
    expect([...hideableUrls(buried, all(A))]).toEqual([]);
  });

  // ⚠⚠ #774. The span's end was measured to the end of the TRIMMED address, so the `.` the
  // trimmer had just discarded sat between the span and the end of the message and failed the
  // "nothing but whitespace after it" test. The same URL at the FRONT hid regardless, because
  // the leading check is vacuously true at offset zero — so identical punctuation produced
  // opposite verdicts decided by nothing but which end the URL sat at. Ported from
  // PreviewHidingTests.trimmedPunctuationDoesNotBlockThePeel in lurker-ios.
  it('is not blocked by punctuation the address trim discarded', () => {
    expect([...hideableUrls(`look at this ${A}.`, all(A))]).toEqual([A]);
    expect([...hideableUrls(`look at this ${A}!`, all(A))]).toEqual([A]);
    expect([...hideableUrls(`look at this ${A}?`, all(A))]).toEqual([A]);
    expect([...hideableUrls(`look at this ${A}...`, all(A))]).toEqual([A]);
    // ...and prose still wins over punctuation, which is the rule the fix must not soften.
    expect([...hideableUrls(`I read ${A}. this morning`, all(A))]).toEqual([]);
  });

  // ⚠⚠ A closing delimiter has a PARTNER sitting before the address, so it is not the URL's to
  // take. The first cut of #774 absorbed everything trimTrailingPunctuation discarded, which
  // made these hideable — and rendered `look at this (…)` as a line holding a lone `(` above the
  // picture, the same orphan the fix exists to remove, moved to the other end. Not hiding them
  // is the conservative answer: the address stays on screen next to its preview, which is
  // merely redundant rather than broken.
  it('will not absorb a delimiter whose partner is in the prose', () => {
    expect([...hideableUrls(`look at this (${A})`, all(A))]).toEqual([]);
    expect([...hideableUrls(`look at this [${A}]`, all(A))]).toEqual([]);
    expect([...hideableUrls(`he said "check ${A}"`, all(A))]).toEqual([]);
  });

  // ⚠ Measured on the VISIBLE text, not on the regex match, which stops at a run boundary. Bold
  // or colour wrapped around just the address is a common bot output shape, and it used to
  // decide the verdict: the identical plain-text message hid.
  it('sees punctuation across a formatting boundary', () => {
    expect([...hideableUrls(`look at this \u0002${A}\u0002.`, all(A))]).toEqual([A]);
    expect([...hideableUrls(`look at this \u001f${A}\u000f.`, all(A))]).toEqual([A]);
  });

  it('hides nothing when there are no candidates', () => {
    expect([...hideableUrls(`${A} ${B}`, new Set())]).toEqual([]);
    expect([...hideableUrls(null, all(A))]).toEqual([]);
  });

  it('never hides a bracketed URL, which has no preview to stand in for it', () => {
    expect([...hideableUrls(`<${A}>`, all(A))]).toEqual([]);
  });
});

describe('segmentsWithoutUrls — closing the gap', () => {
  const A = 'https://e.test/a.png';

  it('returns the very same array when nothing is hidden', () => {
    // Runs per message row, so the common case must not allocate.
    const segs = [{ text: 'hello' }];
    expect(segmentsWithoutUrls(segs, new Set())).toBe(segs);
    expect(segmentsWithoutUrls(segs, new Set(['https://other']))).toBe(segs);
  });

  it('drops the segment and the whitespace it leaves behind', () => {
    const segs = [{ text: 'look at this ' }, { text: A, url: A }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: 'look at this' }]);
  });

  it('leaves nothing at all for a message that was only a link', () => {
    expect(segmentsWithoutUrls([{ text: A, url: A }], new Set([A]))).toEqual([]);
  });

  // ⚠⚠ The other half of #774, and the half that decides whether the span fix is a fix or just
  // a relocation of the damage. The hiding rule counts trailing punctuation as part of the
  // address, so the deletion has to as well — the linkifier trims it off into a text segment of
  // its own, and the end-trim below strips whitespace only.
  it('takes the punctuation the address trim split off with it', () => {
    const segs = [{ text: 'look at this ' }, { text: A, url: A }, { text: '.' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: 'look at this' }]);
  });

  it('leaves nothing for a message that was only a link and a full stop', () => {
    // The worst version of it: the body was a single `.`, which is not empty — so the
    // attachments-only collapse never fired and a line holding one full stop was painted
    // above the picture.
    const segs = [{ text: A, url: A }, { text: '.' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([]);
  });

  it('leaves a closing delimiter alone, because its partner is not the URL to take', () => {
    // ⚠⚠ The deletion must remove exactly what the SPAN counted, no more. It counted no `)`
    // (hideableUrls won't hide a wrapped URL at all now), so neither does this — and the
    // assertion is here rather than only on the verdict because the first cut of the fix did
    // strip it, leaving `(` alone on a line above the picture. If a caller ever hides one
    // anyway, the bracket survives rather than being half-deleted.
    const wrapped = [{ text: '(' }, { text: A, url: A }, { text: ')' }];
    expect(segmentsWithoutUrls(wrapped, new Set([A]))).toEqual([{ text: '(' }, { text: ')' }]);
  });

  it('follows a punctuation run across a formatting boundary', () => {
    // The span crosses runs, so the deletion has to as well or it leaves the tail behind.
    const segs = [{ text: A, url: A }, { text: '.', bold: true }, { text: '.' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([]);
  });

  it('stops absorbing once a segment survives', () => {
    // ⚠ A positive control for the rule above: carrying on past a segment that kept text would
    // eat punctuation belonging to whatever came after.
    const segs = [{ text: A, url: A }, { text: '. done' }, { text: '. and more' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([
      { text: 'done' },
      { text: '. and more' },
    ]);
  });

  it('does not eat text that merely follows a hidden URL', () => {
    // The stripping is bounded by what the trimmer would have taken — the run stops at the
    // first character it would have kept.
    const segs = [{ text: A, url: A }, { text: ', which I liked' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: 'which I liked' }]);
    const spaced = [{ text: A, url: A }, { text: ' see also' }];
    expect(segmentsWithoutUrls(spaced, new Set([A]))).toEqual([{ text: 'see also' }]);
  });

  it('leaves punctuation that is painted ink alone', () => {
    // Same rule as the whitespace trim: a mIRC background run is a drawing, so a `.` sitting on
    // one is not stray punctuation to be tidied away.
    const segs = [
      { text: A, url: A },
      { text: '.', bg: 4 },
    ];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: '.', bg: 4 }]);
  });

  it('trims the front too, so a leading link does not leave an indent', () => {
    const segs = [{ text: A, url: A }, { text: ' and here it is' }];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: 'and here it is' }]);
  });

  it('keeps a coloured BACKGROUND run, whose spaces are ink', () => {
    // ⚠ A mIRC background paints its whitespace, so collapsing it deletes part of a drawing —
    // the one case where a whitespace-only segment is something a reader can see.
    const segs = [
      { text: '   ', bg: 4 },
      { text: A, url: A },
    ];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: '   ', bg: 4 }]);
  });

  it('does not mutate the segments it was given', () => {
    // They are a Vue PROP, and `filter`/`slice` both preserve object identity — so an in-place
    // trim writes back into the caller's array. Harmless only for as long as MessageList rebuilds
    // that array every render; memoise the split and the body stays mangled after the preview
    // goes away.
    //
    // ⚠⚠ BOTH ends, with fixtures chosen so each trim actually FIRES. The first version asserted
    // one case (`[{text:'hi '}, {url}]`) that no mutation could redden: 'hi ' has no leading
    // whitespace, so the front trim is a no-op on the string, and by the time the back trim runs
    // `out[0]` has already been replaced by a copy. A probe said so in seconds; reasoning did not.
    const front = [{ text: A, url: A }, { text: '  and here' }];
    segmentsWithoutUrls(front, new Set([A]));
    expect(front[1].text).toBe('  and here');

    const back = [{ text: 'a ' }, { text: 'b  ' }, { text: A, url: A }];
    segmentsWithoutUrls(back, new Set([A]));
    expect(back[1].text).toBe('b  ');
  });
});

describe('segmentsWithoutUrls — whitespace that is actually ink', () => {
  const A = 'https://e.test/a.png';

  // ⚠ /code-review high: the guard excluded `bg` and stopped there, while its own comment claimed
  // to cover "whitespace a reader can see". An underline or a strike paints a rule across spaces
  // just as a background paints a block.
  it('keeps an UNDERLINED or STRUCK run of spaces', () => {
    for (const attr of [{ underline: true }, { strike: true }]) {
      const segs = [
        { text: '   ', ...attr },
        { text: A, url: A },
      ];
      expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: '   ', ...attr }]);
    }
  });

  it('still trims ordinary whitespace that merely carries a colour', () => {
    // ⚠ The complement, so the guard cannot be "widened" into never trimming anything. A
    // FOREGROUND colour paints nothing on a space — only bg/underline/strike do.
    const segs = [
      { text: 'hi ', fg: 4 },
      { text: A, url: A },
    ];
    expect(segmentsWithoutUrls(segs, new Set([A]))).toEqual([{ text: 'hi', fg: 4 }]);
  });
});
