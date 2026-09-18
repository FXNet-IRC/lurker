// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Settings → Bouncer: where to connect, and the two sign-in forms. What it
// shows comes from GET /api/bouncer, except the hostname when the operator
// pinned none — then it's the host this page is on, because the bouncer answers
// on its own port beside the web app.

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

// Renders its slot and its target, unlike the default stub: what a link SAYS
// and where it GOES are both the point.
const LINK_STUB = {
  props: ['to'],
  template: '<a class="rl" :data-to="JSON.stringify(to)"><slot /></a>',
};

type Info = {
  host: string | null;
  port: number;
  tls: boolean;
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

// The connection table as { label: value }.
function table(w: Awaited<ReturnType<typeof mountWith>>): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const tr of w.findAll('.connect tr')) {
    const cells = tr.findAll('td');
    rows[cells[0].text()] = cells[1].text();
  }
  return rows;
}

beforeEach(() => {
  h.api.mockReset();
});

describe('BouncerPane', () => {
  it('shows where to connect', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true });
    expect(h.api).toHaveBeenCalledWith('/api/bouncer');
    expect(table(w)).toEqual({ Server: 'irc.example.com', Port: '6697', TLS: 'Yes' });
  });

  it("uses the page's own hostname when the operator pinned none", async () => {
    const w = await mountWith({ host: null, port: 6667, tls: true });
    expect(table(w).Server).toBe(window.location.hostname);
  });

  it('says so when the connection is plaintext', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6667, tls: false });
    expect(table(w).TLS).toBe('No');
  });

  // A port and a "use TLS" that were guessed are a sign-in that doesn't work,
  // which is worse than saying the address couldn't be read.
  it('says the address is unknown rather than inventing one, and still explains signing in', async () => {
    const w = await mountWith(new Error('nope'));
    expect(w.find('.connect').exists()).toBe(false);
    expect(w.text()).toContain('couldn’t be read');
    expect(w.text()).not.toContain('6667');
    expect(w.text()).not.toContain(window.location.hostname);
    expect(w.text()).toContain('brad/libera');
  });

  it("gives both sign-in forms, with one of the account's own networks", async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true }, ['libera']);
    const text = w.text();
    // Every network at once for a client that can list them, one at a time otherwise.
    expect(text).toContain('soju.im/bouncer-networks');
    expect(text).toContain('brad');
    expect(text).toContain('brad/libera');
  });

  it('falls back to a placeholder network for an account with none yet', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true }, []);
    expect(w.text()).toContain('brad/network');
  });

  it('names the token scope the bouncer accepts, in the link and in its target', async () => {
    const w = await mountWith({ host: 'irc.example.com', port: 6697, tls: true });
    // The link goes to a pane that defaults to read-only, and the bouncer
    // refuses that token — so the scope belongs in the link, not only beside it.
    const token = w.findAll('a.rl').find((a) => a.text().includes('API token'))!;
    expect(token.text()).toBe('read-write API token');
    expect(JSON.parse(token.attributes('data-to')!)).toEqual({
      path: '/settings/api-tokens',
      query: { scope: 'read-write' },
    });
  });

  // The default install serves a certificate it made itself, which a client
  // refuses until the member accepts it.
  it('shows a self-signed fingerprint, and nothing when the certificate is not ours', async () => {
    const own = await mountWith({
      host: null,
      port: 6667,
      tls: true,
      certificate: { selfSigned: true, fingerprint: 'AA:BB:CC' },
    });
    expect(own.text()).toContain('AA:BB:CC');
    expect(own.text()).toContain('SHA-256');

    const theirs = await mountWith({ host: 'irc.example.com', port: 6697, tls: true });
    expect(theirs.text()).not.toContain('SHA-256');
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
      certificate: null,
    }));
    const w = mount(BouncerPane, { global: { stubs: { RouterLink: LINK_STUB } } });
    await flushPromises();
    expect(fetchAll).toHaveBeenCalled();
    expect(w.text()).toContain('brad/libera');
  });
});
