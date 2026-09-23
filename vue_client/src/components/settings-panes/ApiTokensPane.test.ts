// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Settings → Bouncer sends people here for a token to log an IRC client in
// with, and the bouncer refuses a read-only one — so that link asks for the
// write box to start ticked.

import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string) => Promise<unknown>>(),
  query: {} as Record<string, string>,
}));
vi.mock('../../api.js', () => ({ api: h.api }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: h.query }) }));

import ApiTokensPane from './ApiTokensPane.vue';

async function mountWith(query: Record<string, string>) {
  setActivePinia(createPinia());
  h.query = query;
  h.api.mockImplementation(async () => ({ items: [] }));
  const wrapper = mount(ApiTokensPane);
  await flushPromises();
  return wrapper;
}

describe('ApiTokensPane', () => {
  it('starts read-only, as most tokens should be', async () => {
    const w = await mountWith({});
    expect((w.find('.check input').element as HTMLInputElement).checked).toBe(false);
  });

  it('starts write-enabled when asked for the scope the bouncer needs', async () => {
    const w = await mountWith({ scope: 'read-write' });
    expect((w.find('.check input').element as HTMLInputElement).checked).toBe(true);
  });
});
