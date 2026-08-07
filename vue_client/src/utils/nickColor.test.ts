// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  splitTextByTokens,
  segmentInlineStyle,
  segmentHasStyle,
  MIRC_PALETTE_FALLBACK,
} from './nickColor.js';
import { getOption } from '../../../shared/settingsRegistry.js';

// IRC formatting control bytes used to build test fixtures.
const C = '\x03'; // colour
const RESET = '\x0f'; // reset all
const BOLD = '\x02';

// Run the formatting-only path (no nick set / colouring).
function parse(text: string) {
  return splitTextByTokens(text, null, null, null);
}

describe('MIRC_PALETTE_FALLBACK', () => {
  // The bug that prompted this: slot 1 ("black") was var(--bg), which IS the
  // surface the text is drawn on — so black text rendered in precisely the
  // colour behind it and vanished.
  //
  // The rule is narrow on purpose. Theme variables are RIGHT for the mono-ish
  // slots: look.color.bg and look.color.fg are user-settable, so a slot pinned
  // to a literal near-white would vanish the moment someone sets a light
  // background — the same bug mirrored. What can never appear is the background
  // itself, which is the one value guaranteed to match its own surface.
  it('never paints a slot in the background colour', () => {
    for (const [i, entry] of MIRC_PALETTE_FALLBACK.entries()) {
      expect(entry, `slot ${i}`).not.toMatch(/var\(\s*--bg\b/);
    }
  });

  it('has all 16 slots', () => {
    expect(MIRC_PALETTE_FALLBACK).toHaveLength(16);
  });

  // Two copies exist: this one (the render-time fallback) and the registry
  // default the user's customisable palette starts from. They are the same
  // palette, and a drift between them means chat renders one way until the user
  // opens Settings and a different way afterwards.
  it('matches the look.color.mirc_colors registry default exactly', () => {
    const opt = getOption('look.color.mirc_colors');
    expect(opt?.default).toEqual([...MIRC_PALETTE_FALLBACK]);
  });
});

describe('splitTextByTokens — background colour', () => {
  it('keeps both foreground and background of a \\x03FG,BG run', () => {
    const segs = parse(`${C}04,08hi${C}`);
    expect(segs).toEqual([{ text: 'hi', fg: 4, bg: 8 }]);
  });

  it('leaves the background unchanged when a later code sets only a foreground', () => {
    // \x0308,02 sets fg+bg; \x0304 then recolours the text but keeps bg=2.
    const segs = parse(`${C}08,02a${C}04b`);
    expect(segs).toEqual([
      { text: 'a', fg: 8, bg: 2 },
      { text: 'b', fg: 4, bg: 2 },
    ]);
  });

  it('resets both fg and bg on a bare \\x03', () => {
    const segs = parse(`${C}04,08a${C}b`);
    expect(segs).toEqual([{ text: 'a', fg: 4, bg: 8 }, { text: 'b' }]);
  });

  it('resets both fg and bg on \\x0F', () => {
    const segs = parse(`${C}04,08a${RESET}b`);
    expect(segs).toEqual([{ text: 'a', fg: 4, bg: 8 }, { text: 'b' }]);
  });
});

describe('splitTextByTokens — spoiler detection', () => {
  it('emits a single spoiler segment when fg equals bg, preserving the chosen colour', () => {
    const segs = parse(`${C}01,01secret${C}`);
    expect(segs).toEqual([{ text: 'secret', spoiler: true, fg: 1 }]);
  });

  it('treats any matching fg/bg pair as a spoiler, not just 01,01', () => {
    const segs = parse(`${C}04,04hidden${C}`);
    expect(segs).toEqual([{ text: 'hidden', spoiler: true, fg: 4 }]);
  });

  it('does not split a URL out of a spoiler run (no leak)', () => {
    const segs = parse(`${C}01,01see https://example.com${C}`);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: 'see https://example.com', spoiler: true, fg: 1 });
    expect(segs[0].url).toBeUndefined();
  });

  it('keeps active bold/italic toggles on the spoiler segment', () => {
    const segs = parse(`${BOLD}${C}01,01x${C}`);
    expect(segs).toEqual([{ text: 'x', spoiler: true, fg: 1, bold: true }]);
  });

  it('does not treat differing fg/bg as a spoiler', () => {
    const segs = parse(`${C}01,02x${C}`);
    expect(segs).toEqual([{ text: 'x', fg: 1, bg: 2 }]);
  });
});

describe('splitTextByTokens — channel detection', () => {
  it('splits a #channel into its own segment carrying a channel field', () => {
    expect(parse('join #general now')).toEqual([
      { text: 'join ' },
      { text: '#general', channel: '#general' },
      { text: ' now' },
    ]);
  });

  it('keeps the whole token for a ##-prefixed channel', () => {
    expect(parse('##python is great')).toEqual([
      { text: '##python', channel: '##python' },
      { text: ' is great' },
    ]);
  });

  it('matches a channel at the very start of the text', () => {
    expect(parse('#foo')).toEqual([{ text: '#foo', channel: '#foo' }]);
  });

  it('keeps dashes and dots inside a channel name', () => {
    expect(parse('try #my-cool.chan ok')).toEqual([
      { text: 'try ' },
      { text: '#my-cool.chan', channel: '#my-cool.chan' },
      { text: ' ok' },
    ]);
  });

  it('stops a channel name at a colon (RFC 2812 chanstring)', () => {
    expect(parse('ping #ops:admins now')).toEqual([
      { text: 'ping ' },
      { text: '#ops', channel: '#ops' },
      { text: ':admins now' },
    ]);
  });

  it('ignores a token that trims down to just the bare prefix', () => {
    // "#." matches the regex but trims to "#" — not enough to be a channel.
    expect(parse('look at #. ok')).toEqual([{ text: 'look at #. ok' }]);
  });

  it('trims trailing sentence punctuation off a channel', () => {
    expect(parse('see (#foo).')).toEqual([
      { text: 'see (' },
      { text: '#foo', channel: '#foo' },
      { text: ').' },
    ]);
  });

  it('does not treat "C#" as a channel — the # follows a word char', () => {
    expect(parse('I write C# daily')).toEqual([{ text: 'I write C# daily' }]);
  });

  it('does not treat a bare "#" as a channel', () => {
    expect(parse('a # b')).toEqual([{ text: 'a # b' }]);
  });

  it('leaves a # fragment inside a URL alone', () => {
    expect(parse('docs https://example.com/page#install here')).toEqual([
      { text: 'docs ' },
      {
        url: 'https://example.com/page#install',
        text: 'https://example.com/page#install',
      },
      { text: ' here' },
    ]);
  });

  it('carries active IRC formatting onto a channel segment', () => {
    expect(parse(`${BOLD}#bold-chan`)).toEqual([
      { text: '#bold-chan', channel: '#bold-chan', bold: true },
    ]);
  });
});

describe('segmentInlineStyle / segmentHasStyle — background colour', () => {
  it('maps fg and bg codes to CSS colours via the fallback palette', () => {
    // No palette argument → fall back to MIRC_PALETTE_FALLBACK. Slot 4 is
    // red, slot 8 is yellow.
    expect(segmentInlineStyle({ text: 'x', fg: 4, bg: 8 }, null)).toEqual({
      color: '#ff6188',
      backgroundColor: '#ffd866',
    });
  });

  it('renders a background even when the foreground is the default (99)', () => {
    // \x0399,01 — default text on the "black" slot. Black is a literal colour,
    // not var(--bg): a slot that resolved to the surface it's painted on would
    // render as no box at all.
    const style = segmentInlineStyle({ text: 'x', fg: 99, bg: 1 }, null);
    expect(style.color).toBeUndefined();
    expect(style.backgroundColor).toBe('#000000');
  });

  it('honours a caller-supplied palette over the fallback', () => {
    const palette = Array(16).fill('#abcdef');
    palette[4] = '#deadbe';
    const style = segmentInlineStyle({ text: 'x', fg: 4 }, null, palette);
    expect(style.color).toBe('#deadbe');
  });

  it('reports a background-only segment as styled', () => {
    expect(segmentHasStyle({ text: 'x', bg: 8 })).toBe(true);
    expect(segmentHasStyle({ text: 'x' })).toBe(false);
  });
});

describe('splitTextByTokens — emoji shortcodes', () => {
  // A stand-in for the emoji table so the render-time pass is deterministic
  // without loading the real ~1,900-entry chunk. The real resolver (emojiGlyph)
  // is exercised in emojiShortcodes.test.ts.
  const FAKE: Record<string, string> = {
    smile: '😄',
    tada: '🎉',
    '+1': '👍',
    'e-mail': '📧',
  };
  const emoji = (name: string): string | null => FAKE[name.toLowerCase()] ?? null;
  const parseEmoji = (text: string) => splitTextByTokens(text, null, null, null, emoji);

  it('replaces a known :shortcode: with its glyph', () => {
    expect(parseEmoji(':smile:')).toEqual([{ text: '😄' }]);
  });

  it('replaces a shortcode mid-sentence, keeping the surrounding text', () => {
    expect(parseEmoji('well :tada: done')).toEqual([
      { text: 'well ' },
      { text: '🎉' },
      { text: ' done' },
    ]);
  });

  it('matches a case-insensitive shortcode', () => {
    expect(parseEmoji(':TADA:')).toEqual([{ text: '🎉' }]);
  });

  it('handles + and - inside the shortcode name', () => {
    expect(parseEmoji('nice :+1: then :e-mail:')).toEqual([
      { text: 'nice ' },
      { text: '👍' },
      { text: ' then ' },
      { text: '📧' },
    ]);
  });

  it('converts adjacent shortcodes', () => {
    expect(parseEmoji(':+1::+1:')).toEqual([{ text: '👍' }, { text: '👍' }]);
  });

  it('leaves an unknown shortcode literal', () => {
    expect(parseEmoji('what :nope: is')).toEqual([{ text: 'what :nope: is' }]);
  });

  it('does not convert when the opening colon hugs a preceding word char', () => {
    // The composer's boundary rule: "word:smile:" is not a shortcode start.
    expect(parseEmoji('word:smile:')).toEqual([{ text: 'word:smile:' }]);
  });

  it('does not convert a clock like 12:00:00', () => {
    expect(parseEmoji('at 12:00:00 sharp')).toEqual([{ text: 'at 12:00:00 sharp' }]);
  });

  it('passes text through unchanged when no emojiFn is supplied', () => {
    // The 4-arg form (LinkedText pre-load, composer-less callers) never converts.
    expect(splitTextByTokens(':smile:', null, null, null)).toEqual([{ text: ':smile:' }]);
  });

  it('carries active IRC formatting onto an emoji glyph', () => {
    expect(splitTextByTokens(`${BOLD}:tada:`, null, null, null, emoji)).toEqual([
      { text: '🎉', bold: true },
    ]);
  });

  it('runs after channel splitting — a shortcode after a #channel still converts', () => {
    expect(parseEmoji('#chan :tada:')).toEqual([
      { text: '#chan', channel: '#chan' },
      { text: ' ' },
      { text: '🎉' },
    ]);
  });

  it('still colours a nick that follows an emoji', () => {
    const nickSet = new Set(['alice']);
    const color = (n: string): string | null => (n.toLowerCase() === 'alice' ? '#f00' : null);
    expect(splitTextByTokens(':tada: alice', nickSet, null, color, emoji)).toEqual([
      { text: '🎉' },
      { text: ' ' },
      { text: 'alice', color: '#f00', self: false },
    ]);
  });
});
