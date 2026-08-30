// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Implicit form submission under an IME (#622).
//
// The other half of unfreezing a model, at the call site where it is easiest to
// reach. This form's save button goes live as soon as the DRIVER fields are
// complete — which is before you have finished the Name if you type it last —
// so the Enter that confirms a CJK candidate would implicitly submit the form
// and create the uploader early, under the driver's default name rather than the
// one still sitting in the preedit.
//
// Worth a call-site test rather than trusting blockImeEnter's own unit coverage:
// what can go wrong here is the binding, not the handler.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import UploaderConfigForm from './UploaderConfigForm.vue';
import type { UploaderDriver } from '../utils/uploaders.js';

const DRIVER: UploaderDriver = {
  driver: 'test',
  label: 'Test Driver',
  creatable: true,
  configSchema: [
    { key: 'endpoint', label: 'Endpoint', type: 'string', required: true, description: '' },
  ],
};

// A form whose required driver field is already filled, so the submit button is
// enabled and implicit submission is actually reachable.
function mountReady() {
  const wrapper = mount(UploaderConfigForm, {
    props: { driver: DRIVER },
    attachTo: document.body,
  });
  const [nameEl, endpointEl] = wrapper.findAll('input').map((n) => n.element as HTMLInputElement);
  endpointEl.value = 'https://example.test';
  endpointEl.dispatchEvent(new Event('input', { bubbles: true }));
  return { wrapper, nameEl };
}

function pressEnter(el: HTMLInputElement, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
}

// NB: these assert on defaultPrevented rather than on a 'save' emit, because
// happy-dom does not implement implicit form submission — a synthetic Enter
// never submits there, IME or not, so an emit-based assertion would pass
// whether or not the binding existed. Cancelling the default IS the mechanism
// that stops the real browser submitting, so this is the observable half; the
// consequence is a browser behaviour, and belongs to the manual QA recipe.
describe('UploaderConfigForm under IME composition', () => {
  it("cancels the Enter that confirms a candidate, so the form can't submit", async () => {
    const { wrapper, nameEl } = mountReady();
    await wrapper.vm.$nextTick();

    // Mid-composition the visible name is preedit and `label` is whatever
    // v-model last let through — neither is what the user means to save, and
    // onSubmit would fall back to the driver's default name.
    nameEl.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    nameEl.value = 'nihao';
    nameEl.dispatchEvent(new Event('input', { bubbles: true }));

    expect(pressEnter(nameEl, { isComposing: true }).defaultPrevented).toBe(true);
    expect(wrapper.emitted('save')).toBeUndefined();
    wrapper.unmount();
  });

  it('leaves a real Enter alone, so the form still submits from the keyboard', async () => {
    // A form you can no longer submit from the keyboard would be a worse bug
    // than the one being fixed.
    const { wrapper, nameEl } = mountReady();
    await wrapper.vm.$nextTick();

    nameEl.value = 'my uploader';
    nameEl.dispatchEvent(new Event('input', { bubbles: true }));

    expect(pressEnter(nameEl).defaultPrevented).toBe(false);
    wrapper.unmount();
  });

  it('gates the driver fields the same way', () => {
    const { wrapper } = mountReady();
    const endpointEl = wrapper.findAll('input')[1].element as HTMLInputElement;

    expect(pressEnter(endpointEl, { isComposing: true }).defaultPrevented).toBe(true);
    expect(pressEnter(endpointEl).defaultPrevented).toBe(false);
    wrapper.unmount();
  });
});
