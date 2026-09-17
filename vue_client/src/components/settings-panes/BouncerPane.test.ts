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

// Renders its slot and its target, unlike the default stub: what the link SAYS
// and where it GOES are both the point.
const LINK_STUB = {
  props: ['to'],
  template: '<a class="rl" :data-to="JSON.stringify(to)"><slot /></a>',
};

type Info = {
  host: string | null;
  port: number;
  tls: boolean;
  pinned: boolean;
  certificate?: { selfSigned: boolean; fingerprint: string } | null;
};

async function mountWith(info: Info | Error, networks: string[] = ['libera']) {
  setActivePinia(createPinia());
  useAuthStore().user = { id: 1, username: 'brad', role: 'user' } as never;
  const store = useNetworksStore();
  store.networks = networks.map((name, i) => ({ id: i + 1, name })) as never;
  // Seeded, so the pane doesn't go and fetch them (its own test below covers that).
  store.loaded = true;
  h.api.mockImplementation(async () => {
    if (info instanceof Error) throw info;
    return { certificate: null, ...info };
  });
  const wrapper = mount(BouncerPane, { global: { stubs: { RouterLink: LINK_STUB } } });
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

  // The default install serves a certificate it made itself, which a client
  // refuses until the member accepts it.
  it('warns about a self-signed certificate, with the fingerprint to check', async () => {
    const w = await mountWith({
      host: null,
      port: 6667,
      tls: true,
      pinned: false,
      certificate: { selfSigned: true, fingerprint: 'AA:BB:CC' },
    });
    expect(w.text()).toContain('AA:BB:CC');
    expect(w.text()).toContain('trust it');
  });

  it("says nothing about a certificate when it isn't Lurker's to explain", async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true, pinned: true });
    expect(w.text()).not.toContain('fingerprint');
  });

  // A single "server password" box takes both, and a colon in the password
  // can't survive that form.
  it('spells out the combined server-password form', async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false });
    expect(w.text()).toContain('brad:your-password');
  });

  it('names the token scope the bouncer actually accepts, in the link itself', async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false });
    // The link goes to a pane that defaults to read-only, and the bouncer
    // refuses that token — so the scope belongs in the link, not only in the
    // paragraph below it.
    expect(w.find('a.rl').text()).toBe('read-write API token');
    expect(w.text()).toContain('A read-only token is refused');
  });

  // The tokens pane defaults to read-only, which the bouncer refuses, so the
  // link asks for the write box to start ticked.
  it('asks the tokens pane for the scope the bouncer needs', async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false });
    expect(JSON.parse(w.find('a.rl').attributes('data-to')!)).toEqual({
      path: '/settings/api-tokens',
      query: { scope: 'read-write' },
    });
  });

  it('fetches the networks itself, for a page loaded without the chat socket', async () => {
    setActivePinia(createPinia());
    useAuthStore().user = { id: 1, username: 'brad', role: 'user' } as never;
    const networks = useNetworksStore();
    const fetchAll = vi.fn<() => Promise<void>>(async () => {
      networks.networks = [{ id: 1, name: 'libera' }] as never;
      networks.loaded = true;
    });
    networks.fetchAll = fetchAll as never;
    h.api.mockImplementation(async () => ({
      host: null,
      port: 6667,
      tls: true,
      pinned: false,
      certificate: null,
    }));
    const w = mount(BouncerPane, { global: { stubs: { RouterLink: LINK_STUB } } });
    await flushPromises();
    expect(fetchAll).toHaveBeenCalled();
    expect(w.text()).toContain('brad/libera');
  });

  // A port and a "use TLS" that were guessed are a login that doesn't work,
  // which is worse than saying the address couldn't be read.
  it('says the address is unknown rather than inventing one, and still explains the login', async () => {
    const w = await mountWith(new Error('nope'));
    expect(w.text()).toContain('brad/libera');
    expect(w.text()).toContain('couldn’t be read just now');
    expect(w.text()).not.toContain('6667');
    expect(w.text()).not.toContain(window.location.hostname);
    // Nothing to explain about an address that isn't shown.
    expect(w.text()).not.toContain('LURKER_BOUNCER_PUBLIC_URL');
  });

  it('leaves out the single-network form for an account with no networks yet', async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true, pinned: false }, []);
    expect(w.text()).toContain('brad');
    expect(w.text()).not.toContain('brad/');
    expect(w.text()).not.toContain('one network');
  });
});
