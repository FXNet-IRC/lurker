// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The quick switcher at a real call site, mid-composition.
//
// useImeSafeInput.test.ts proves the binding in isolation, with a v-model
// control to show the assertions can fail. This is the other half: that the
// switcher's filter is actually wired to it, so the list narrows while an
// Android keyboard is still composing the word instead of sitting on the
// unfiltered set until the keyboard is dismissed.
//
// The switcher stands in for the other eleven fields (#622) — they all bind the
// same `:value` + `@input` pair, and the composable's own suite covers what the
// binding does. Reintroducing v-model here is what this catches.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import QuickSwitcher from './QuickSwitcher.vue';

const CHANNELS = ['#apple', '#mango', '#zebra'];

function seedStores() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me' } } as never;
  for (const target of CHANNELS) {
    buffers.buffers[`1::${target}`] = { networkId: 1, target, members: [], messages: [] } as never;
  }
  networks.activeKey = '1::#apple';
  buffersActivated = [];
  buffers.activate = ((networkId: number, target: string) => {
    buffersActivated.push(`${networkId}::${target}`);
  }) as never;
}

let mounted: VueWrapper[] = [];
let buffersActivated: string[] = [];

async function mountSwitcher() {
  const wrapper = mount(QuickSwitcher, { attachTo: document.body });
  mounted.push(wrapper);
  await nextFrame();
  const input = wrapper.find('input.filter');
  expect(input.exists()).toBe(true);
  return { wrapper, el: input.element as HTMLInputElement };
}

async function nextFrame() {
  await new Promise((r) => setTimeout(r, 0));
}

// A soft keyboard delivering one word: the DOM value updates per keystroke
// inside a composing run that never ends. See composeWord in
// useImeSafeInput.test.ts.
async function composeWord(el: HTMLInputElement, word: string) {
  el.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  for (let i = 1; i <= word.length; i++) {
    el.value = word.slice(0, i);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await nextFrame();
}

function labels(wrapper: VueWrapper) {
  return wrapper.findAll('li.row .target').map((n) => n.text());
}

describe('QuickSwitcher filter under IME composition', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedStores();
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('narrows the list while the word is still composing', async () => {
    const { wrapper, el } = await mountSwitcher();
    // Sanity: with no query this is the alt-tab view, so the active buffer
    // (#apple) is dropped for a reason unrelated to the filter, and the
    // network's own server row rides along from flattenBufferOrder.
    expect(labels(wrapper)).toEqual(['[server]', '#mango', '#zebra']);

    await composeWord(el, 'zeb');

    expect(labels(wrapper)).toEqual(['#zebra']);
  });

  it('ignores the Enter that confirms an IME candidate', async () => {
    // The regression a live model opens up: onKeydown's Enter branch picks the
    // selected row, and with v-model gone this keypress is no longer answered
    // with a stale-and-harmless query. The IME owns Enter while composing — it
    // is confirming a candidate, not asking to switch buffers.
    const { wrapper, el } = await mountSwitcher();
    await composeWord(el, 'zeb');

    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
    await nextFrame();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(buffersActivated).toEqual([]);
  });

  it('keeps narrowing as the composed word grows', async () => {
    // The frozen-model failure isn't "no filtering at all" — it's filtering on
    // whatever the model held when the composition opened. Typing a second
    // word after a committed first would still narrow, just to the wrong set.
    const { wrapper, el } = await mountSwitcher();

    await composeWord(el, 'm');
    expect(labels(wrapper)).toEqual(['#mango']);

    await composeWord(el, 'mangoes');
    expect(labels(wrapper)).toEqual([]);
    expect(wrapper.find('p.empty').exists()).toBe(true);
  });
});
