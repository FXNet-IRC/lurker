// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Settings → Bouncer: the address and the two username forms a member needs to
// attach an IRC client. What it shows comes from GET /api/bouncer, except the
// hostname when the operator pinned none — then it's the host this page is on,
// because the bouncer answers on its own port beside the web app.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));

import BouncerPane from './BouncerPane.vue';
import { useAuthStore } from '../../stores/auth.js';
import { useNetworksStore } from '../../stores/networks.js';

type Info = { host: string | null; port: number; tls: boolean; pinned: boolean };

async function mountWith(info: Info | Error, networks: string[] = ['libera']) {
  setActivePinia(createPinia());
  useAuthStore().user = { id: 1, username: 'brad', role: 'user' } as never;
  useNetworksStore().networks = networks.map((name, i) => ({ id: i + 1, name })) as never;
  h.api.mockImplementation(async () => {
    if (info instanceof Error) throw info;
    return info;
  });
  const wrapper = mount(BouncerPane, { global: { stubs: { RouterLink: true } } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  h.api.mockReset();
});

describe('BouncerPane', () => {
  it('shows the pinned address, the login forms and the networks to pick from', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true, pinned: true }, [
      'libera',
      'oftc',
    ]);
    expect(h.api).toHaveBeenCalledWith('/api/bouncer');
    const text = w.text();
    expect(text).toContain('irc.example.com');
    expect(text).toContain('6697');
    expect(text).toContain('TLS');
    // Plain username for every network, username/network for one.
    expect(text).toContain('brad');
    expect(text).toContain('one network');
    expect(text).toContain('brad/libera');
    expect(text).toContain('oftc');
    // Nothing about pinning an address: the operator already did.
    expect(text).not.toContain('LURKER_BOUNCER_PUBLIC_URL');
  });

  it("uses the page's own hostname when no address is pinned, and says so", async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false });
    expect(w.text()).toContain(window.location.hostname);
    expect(w.text()).toContain('LURKER_BOUNCER_PUBLIC_URL');
  });

  it('leaves out the TLS instruction when the connection is plaintext', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6667, tls: false, pinned: true });
    expect(w.text()).not.toContain('TLS');
  });

  it('still explains the login when the address cannot be read', async () => {
    const w = await mountWith(new Error('nope'));
    expect(w.text()).toContain('brad/libera');
    expect(w.text()).toContain(window.location.hostname);
  });

  it('leaves out the single-network form for an account with no networks yet', async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false }, []);
    expect(w.text()).toContain('brad');
    expect(w.text()).not.toContain('brad/');
    expect(w.text()).not.toContain('one network');
  });
});
