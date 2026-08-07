// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The spoiler box's colour. `01,01` is the pair Lurker's own applySpoilerMarkup
// emits, so this covers every spoiler sent from Lurker.
//
// Originally not merely cosmetic: slot 1 resolved to `var(--bg)`, so honouring
// it as a "chosen colour" painted the box the exact colour of the page AND set
// the revealed text to var(--bg) — clicking a spoiler showed nothing. The
// palette has since been fixed too (slot 1 is a literal #000000), so these guard
// the remaining half: 01,01 means "hidden", not "black", and must not be
// preserved as a styling intent.

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

  // The reported bug. The neutral box comes from the .spoiler class rule
  // (var(--fg-muted)), so "correct" means NO inline background override at all.
  it('does not paint the box with the 01,01 convention colour', () => {
    const { root } = mountSpoiler({ text: 'secret', spoiler: true, fg: 1 });
    expect(root.attributes('style') || '').not.toMatch(/background/);
  });

  // `await` is load-bearing: trigger() resolves on nextTick, and without it the
  // style assertion below would pass against the UNrevealed markup — i.e. pass
  // even with the bug present.
  //
  // Asserts NO inline colour rather than "not var(--bg)". Matching on the old
  // value made this test dead the moment the palette stopped containing it: the
  // guard could be removed and this would still pass, because slot 1 now paints
  // #000000. What the guard actually does is decline to set a colour at all, so
  // that is what's checked.
  it('leaves revealed text its normal colour for a convention spoiler', async () => {
    const { root, body } = mountSpoiler({ text: 'secret', spoiler: true, fg: 1 });
    await root.trigger('click');
    expect(root.classes()).toContain('revealed');
    expect(body.attributes('style') || '').not.toMatch(/(^|[^-])color:/);
  });

  it('paints revealed text in a deliberately chosen colour', async () => {
    const { root, body } = mountSpoiler({ text: 'hidden', spoiler: true, fg: 4 });
    await root.trigger('click');
    expect(body.attributes('style') || '').toMatch(/color/);
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
