// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The composing guard, from both sides.
//
// The fix itself is an absence — with v-model gone there is no composing flag
// left to freeze anything, so a compositionstart-driven test of the fixed
// binding passes trivially. On its own that proves nothing: a test that cannot
// fail is not a regression guard.
//
// So every case here runs against BOTH bindings. The v-model harness is the
// positive control: it is a faithful hand-assembly of what the compiler emits
// for `v-model="model"` on a native input (the vModelText directive, plus the
// `onUpdate:modelValue` assigner it reads out of the vnode), and it is expected
// to FAIL the same assertions the real binding passes. That contrast is what
// gives the passing half its meaning, and it is what fails loudly if someone
// puts v-model back on one of these fields.
//
// What none of this can prove is that a real Android keyboard behaves the way
// these synthetic events say it does. It doesn't need to: the guard lives
// entirely in Vue, not the browser. Device QA covers the other half.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, vModelText, withDirectives, type Ref } from 'vue';
import { blockImeEnter, isImeKey, useImeSafeInput } from './useImeSafeInput.js';

// `:value` + an unconditional @input — what all twelve live-derived fields bind.
function mountImeSafe(model: Ref<string>) {
  return mount(
    defineComponent({
      setup() {
        const onInput = useImeSafeInput(model);
        return () => h('input', { value: model.value, onInput });
      },
    }),
    { attachTo: document.body },
  );
}

// The control: `v-model="model"` on a native input, as the SFC compiler emits
// it. vModelText's created hook pulls its assigner off `onUpdate:modelValue`,
// so the prop is not decoration — without it the directive has nothing to
// write the model through and the harness would fail for the wrong reason.
function mountVModel(model: Ref<string>) {
  return mount(
    defineComponent({
      setup() {
        return () =>
          withDirectives(
            h('input', {
              'onUpdate:modelValue': (v: string) => {
                model.value = v;
              },
            }),
            [[vModelText, model.value]],
          );
      },
    }),
    { attachTo: document.body },
  );
}

// One composed word, as a soft keyboard delivers it: compositionstart, then an
// input event per keystroke with the DOM value already updated. No
// compositionend — that is the point. Everything a user sees mid-word happens
// in here, and on Android "mid-word" is most of the time they spend typing.
async function composeWord(el: HTMLInputElement, word: string) {
  el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  for (let i = 1; i <= word.length; i++) {
    el.value = word.slice(0, i);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await nextTick();
}

describe('useImeSafeInput', () => {
  describe('the read half — DOM to model', () => {
    it('tracks the field while a composition is in flight', async () => {
      const model = ref('');
      const wrapper = mountImeSafe(model);

      await composeWord(wrapper.find('input').element as HTMLInputElement, 'zebra');

      // A live filter, a submit button's :disabled, a computed preview: all of
      // them read this, and all of them were a whole word stale.
      expect(model.value).toBe('zebra');
      wrapper.unmount();
    });

    it('control: v-model freezes the model for the whole word', async () => {
      const model = ref('');
      const wrapper = mountVModel(model);

      await composeWord(wrapper.find('input').element as HTMLInputElement, 'zebra');

      expect(model.value).toBe('');
      wrapper.unmount();
    });
  });

  describe('the write half — model to DOM', () => {
    it('lets a programmatic clear reach the field mid-composition', async () => {
      const model = ref('');
      const wrapper = mountImeSafe(model);
      const el = wrapper.find('input').element as HTMLInputElement;
      await composeWord(el, 'zebra');

      // The uploads browser's clear button and Esc handler, the settings
      // sidebar's reset, the "" after a token or theme is saved.
      model.value = '';
      await nextTick();

      expect(el.value).toBe('');
      wrapper.unmount();
    });

    it('control: v-model leaves the cleared text on screen', async () => {
      const model = ref('');
      const wrapper = mountVModel(model);
      const el = wrapper.find('input').element as HTMLInputElement;
      await composeWord(el, 'zebra');

      // Nothing to clear as far as the model is concerned — the read half
      // already froze it at '' — so drive the divergence the other way and
      // give it a value the DOM does not have.
      model.value = 'mango';
      await nextTick();

      expect(el.value).toBe('zebra');
      wrapper.unmount();
    });
  });

  // The other half of unfreezing the model. v-model used to answer the Enter
  // that confirms a CJK candidate with the PRE-composition value — usually ''
  // — so a submit handler's own `if (!name) return` swallowed it. Now the
  // model holds live preedit, and that same keypress would run the action for
  // real.
  describe("the IME's own Enter", () => {
    const key = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', { key: 'Enter', ...init });

    it('is recognised while a composition is live', () => {
      expect(isImeKey(key({ isComposing: true }))).toBe(true);
    });

    it('is recognised from keyCode 229 after compositionend', () => {
      // Safari fires the confirming Enter once isComposing is already false.
      expect(isImeKey(Object.assign(key({}), { keyCode: 229 }))).toBe(true);
    });

    it('leaves a real Enter alone', () => {
      expect(isImeKey(key({}))).toBe(false);
    });

    it('cancels implicit form submission only for the IME', () => {
      const composing = key({ isComposing: true, cancelable: true });
      blockImeEnter(composing);
      expect(composing.defaultPrevented).toBe(true);

      // A real Enter must still submit the form it sits in.
      const real = key({ cancelable: true });
      blockImeEnter(real);
      expect(real.defaultPrevented).toBe(false);
    });
  });

  it('leaves the caret alone when the model already matches', async () => {
    // Why `:value` is safe to bind on every keystroke: patchDOMProp skips the
    // write when el.value already equals the incoming value, so re-rendering
    // does not reset the selection out from under the user mid-word.
    const model = ref('');
    const wrapper = mountImeSafe(model);
    const el = wrapper.find('input').element as HTMLInputElement;

    await composeWord(el, 'zebra');
    el.setSelectionRange(2, 2);
    await nextTick();

    expect(el.selectionStart).toBe(2);
    wrapper.unmount();
  });
});
