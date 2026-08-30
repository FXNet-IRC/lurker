// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { applySpoilerMarkup } from './spoilerMarkup.js';
import { splitTextByTokens } from './nickColor.js';

// A spoiler on the wire is any run whose foreground and background match. We
// emit grey on grey (14,14) rather than black on black — see the note in
// spoilerMarkup.ts for why the colour is the sender's problem now.
const OPEN = '\x0314,14';
const CLOSE = '\x03';

describe('applySpoilerMarkup', () => {
  it('leaves text with no double-pipes untouched', () => {
    expect(applySpoilerMarkup('hello world')).toBe('hello world');
    expect(applySpoilerMarkup('')).toBe('');
    expect(applySpoilerMarkup('a | b')).toBe('a | b');
  });

  it('rewrites a basic ||spoiler|| into IRC spoiler codes', () => {
    expect(applySpoilerMarkup('||secret||')).toBe(`${OPEN}secret${CLOSE}`);
  });

  it('preserves the text around a spoiler', () => {
    expect(applySpoilerMarkup('the answer is ||42|| ok?')).toBe(
      `the answer is ${OPEN}42${CLOSE} ok?`,
    );
  });

  it('rewrites multiple spoilers in one message', () => {
    expect(applySpoilerMarkup('||a|| and ||b||')).toBe(`${OPEN}a${CLOSE} and ${OPEN}b${CLOSE}`);
  });

  it('pairs non-greedily — the nearest closing || wins', () => {
    // ||a||b||c|| -> spoiler(a), literal b, spoiler(c)
    expect(applySpoilerMarkup('||a||b||c||')).toBe(`${OPEN}a${CLOSE}b${OPEN}c${CLOSE}`);
  });

  it('leaves an unmatched || literal', () => {
    expect(applySpoilerMarkup('||unclosed')).toBe('||unclosed');
    expect(applySpoilerMarkup('trailing||')).toBe('trailing||');
  });

  it('leaves an empty |||| literal', () => {
    expect(applySpoilerMarkup('||||')).toBe('||||');
  });

  it('treats \\|| as an escape, emitting a literal || and no spoiler', () => {
    expect(applySpoilerMarkup('exit code \\|| 1')).toBe('exit code || 1');
    expect(applySpoilerMarkup('\\||not a spoiler\\||')).toBe('||not a spoiler||');
  });

  it('allows an escaped || inside a real spoiler', () => {
    expect(applySpoilerMarkup('||has \\|| inside||')).toBe(`${OPEN}has || inside${CLOSE}`);
  });

  it('leaves a lone backslash literal', () => {
    expect(applySpoilerMarkup('a \\ b')).toBe('a \\ b');
    expect(applySpoilerMarkup('path\\to\\file')).toBe('path\\to\\file');
  });
});

// Everything above pins the bytes we emit. This pins the thing that actually
// matters: that our own renderer reads them back as a spoiler. The two halves
// live in different files and were free to drift — a pair the parser didn't
// recognise would ship as visible plaintext, which for a spoiler is the whole
// failure.
describe('applySpoilerMarkup → splitTextByTokens round trip', () => {
  const parse = (text: string) => splitTextByTokens(text, null, null, null);

  it('emits a run our own parser recognises as a spoiler', () => {
    expect(parse(applySpoilerMarkup('||secret||'))).toEqual([
      { text: 'secret', spoiler: true, fg: 14 },
    ]);
  });

  // The delimiter is two digits and so is the colour code, so a spoiler opening
  // on a digit is where a greedy parse would go wrong: `\x0314,14` + `42` must
  // read as grey-on-grey plus the text "42", not as colour 14,1442.
  it('does not swallow leading digits of the hidden text', () => {
    expect(parse(applySpoilerMarkup('the answer is ||42||'))).toEqual([
      { text: 'the answer is ' },
      { text: '42', spoiler: true, fg: 14 },
    ]);
  });

  it('still recognises an incoming 01,01 spoiler from another client', () => {
    expect(parse('\x0301,01secret\x03')).toEqual([{ text: 'secret', spoiler: true, fg: 1 }]);
  });

  // ⚠⚠ The close is the dangerous end, and it ate typed text. A bare \x03 followed by a digit is
  // a colour CODE, so the digit went with it: `||spoiler||5 stars` reached the channel as
  // " stars" in colour 5 with the "5" deleted, and `the code is ||1234||5678` lost "56" and
  // rendered the rest in colour 56.
  //
  // Asserted as a round trip rather than on the bytes: what matters is that every character
  // typed after the spoiler survives, and that the spoiler's background doesn't bleed onto it.
  it.each([
    ['||spoiler||5 stars', 'spoiler', '5 stars'],
    ['the code is ||1234||5678', '1234', '5678'],
    ['||a||0', 'a', '0'],
  ])('keeps the text after a spoiler when it starts with a digit (%s)', (input, hidden, after) => {
    const segs = parse(applySpoilerMarkup(input));
    const index = segs.findIndex((s) => s.spoiler);
    expect(segs[index]?.text).toBe(hidden);

    const tail = segs.slice(index + 1);
    expect(tail.map((s) => s.text).join('')).toBe(after);
    // …and it must not still be sitting on the spoiler's box, nor be a spoiler itself.
    for (const seg of tail) {
      expect(seg.bg).not.toBe(14);
      expect(seg.spoiler).toBeFalsy();
    }
  });

  it('keeps the cheap one-byte close when nothing collides', () => {
    expect(applySpoilerMarkup('||a|| ok').endsWith('\x03 ok')).toBe(true);
    expect(applySpoilerMarkup('||a||').endsWith('a\x03')).toBe(true);
    // A comma is safe: only a digit can start a colour code.
    expect(applySpoilerMarkup('||a||,b').endsWith('\x03,b')).toBe(true);
  });

  // The half that makes the close above safe. 99 is mIRC's "default" and paints nothing, so a
  // 99,99 run is not hidden text — treating it as a spoiler turned readable text into a grey box
  // nobody could usefully reveal, and would turn the tail of every digit-followed spoiler into
  // one.
  it('does not treat an unrenderable matched pair as a spoiler', () => {
    expect(parse('\x0399,99tail text')).toEqual([{ text: 'tail text', fg: 99, bg: 99 }]);
  });
});
