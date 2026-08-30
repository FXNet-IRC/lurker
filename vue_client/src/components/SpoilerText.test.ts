// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The spoiler box's colour, and the invariant underneath it: the BOX honours
// whatever the sender named, and the REVEAL is always readable.
//
// The two are split for a reason. An fg==bg run is not reliably a spoiler —
// ASCII art fills a solid block the same way — so the box cannot second-guess
// the colour without recolouring somebody's picture. But the revealed text can
// never be allowed to take that colour, because the two commonest values are
// black and white, and each is unreadable against a faint tint of itself on the
// scheme that matches it. A reveal that reveals nothing is the one failure this
// component cannot have.
//
// This replaces an earlier rule that special-cased slot 1 (the pair Lurker's own
// applySpoilerMarkup emits) as "means hidden, not black". That fixed the reveal
// by way of the box, which is the wrong lever — it also repainted art.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SpoilerText from './SpoilerText.vue';
import type { RenderSegment } from '../utils/nickColor.js';

function mountSpoiler(seg: RenderSegment) {
  const wrapper = mount(SpoilerText, { props: { seg } });
  const root = wrapper.find('.spoiler');
  const body = wrapper.find('.spoiler-body');
  return { wrapper, root, body };
}

describe('SpoilerText box colour', () => {
  beforeEach(() => setActivePinia(createPinia()));

  // ASCII art fills solid blocks with fg==bg runs, so a `01,01` box has to come
  // out actually black. Substituting the neutral gray here recoloured the art.
  it('paints the 01,01 box black rather than substituting the neutral gray', () => {
    const { root } = mountSpoiler({ text: 'secret', spoiler: true, fg: 1 });
    expect(root.attributes('style') || '').toMatch(/background:\s*#000000/);
  });

  // The mirror case, and a live regression once slot 0 stopped being var(--fg):
  // white is a colour like any other and the box must be white, even though a
  // white box on the light canvas is 1.1:1 and barely reads as a box.
  it('paints the 00,00 box white', () => {
    const { root } = mountSpoiler({ text: 'secret', spoiler: true, fg: 0 });
    expect(root.attributes('style') || '').toMatch(/background:\s*#ffffff/);
  });

  // `await` is load-bearing: trigger() resolves on nextTick, and without it the
  // style assertion below would pass against the UNrevealed markup — i.e. pass
  // even with the bug present.
  //
  // Asserts NO inline colour rather than "not black". Matching on a specific
  // value is how the previous version of this test went dead: it pinned
  // var(--bg), the palette stopped containing it, and the assertion could no
  // longer fail. What the component does is decline to set a colour at all, so
  // that is what's checked — every colour, not a chosen few.
  it.each([
    ['black', 1],
    ['white', 0],
    ['red', 4],
  ])('leaves revealed text its normal colour (%s spoiler)', async (_name, fg) => {
    const { root, body } = mountSpoiler({ text: 'secret', spoiler: true, fg });
    await root.trigger('click');
    expect(root.classes()).toContain('revealed');
    expect(body.attributes('style') || '').not.toMatch(/(^|[^-])color:/);
  });

  // The feature this bug came in with is still worth having — a chatter who
  // picked red should get a red spoiler, not a generic gray one.
  it('still honours a deliberately chosen colour', () => {
    const { root } = mountSpoiler({ text: 'hidden', spoiler: true, fg: 4 });
    expect(root.attributes('style') || '').toMatch(/background/);
  });

  it('falls back to the neutral box when the segment carries no colour', () => {
    const { root } = mountSpoiler({ text: 'old', spoiler: true });
    expect(root.attributes('style') || '').not.toMatch(/background/);
  });

  // Reveal is one-way and must not leak the text to assistive tech first.
  it('hides the body from screen readers until revealed', async () => {
    const { root, body } = mountSpoiler({ text: 'secret', spoiler: true, fg: 1 });
    expect(body.attributes('aria-hidden')).toBe('true');
    await root.trigger('click');
    expect(body.attributes('aria-hidden')).toBeUndefined();
  });
});
