// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC chat buffer's "not connected" line (#270).
//
// QA asked for the same affordance a DM shows when its peer is offline, for a
// DCC chat whose session is down. A `=nick` buffer has no IRC presence —
// peerFor deliberately answers null for it — so without this it looks exactly
// as usable as a live chat, and the first sign of trouble is a line that
// doesn't send.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import StatusBar from './StatusBar.vue';
import { useNetworksStore } from '../stores/networks.js';

function mountOn(target: string, state: Record<string, unknown>) {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'libera' }] as never;
  networks.states[1] = { networkId: 1, channels: [], ...state } as never;
  networks.activeKey = `1::${target}`;
  return mount(StatusBar, {
    global: { stubs: { SuggestionStrip: true, MircColorPicker: true, UploadMenu: true } },
  });
}

const statusText = (w: ReturnType<typeof mountOn>) => w.find('.peer-status').text();

describe('StatusBar — DCC chat session state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('says a chat with no live session is not connected, styled like an offline peer', () => {
    const w = mountOn('=bob', { state: 'connected', dccChats: [] });
    expect(statusText(w)).toContain('DCC chat with bob is not connected');
    expect(statusText(w)).toContain('/dcc chat bob');
    expect(w.find('.peer-status').classes()).toContain('offline');
  });

  it('shows nothing while the session is live', () => {
    const w = mountOn('=bob', { state: 'connected', dccChats: ['bob'] });
    expect(w.find('.peer-status').exists()).toBe(false);
  });

  // ⚠ The session is independent of the IRC link, so a live chat on a
  // DISCONNECTED network must still read as live — the inverse of a DM, whose
  // peer is reported offline the moment our link drops.
  it('reads the DCC session, never the network, so a live chat stays live offline', () => {
    const w = mountOn('=bob', { state: 'disconnected', dccChats: ['bob'] });
    expect(w.find('.peer-status').exists()).toBe(false);
  });

  it('matches the peer case-insensitively', () => {
    const w = mountOn('=BoB', { state: 'connected', dccChats: ['bob'] });
    expect(w.find('.peer-status').exists()).toBe(false);
  });

  // The line is for DCC chats only — a DM's offline line is unchanged.
  it("leaves a DM's own offline line alone", () => {
    const w = mountOn('bob', { state: 'disconnected' });
    expect(statusText(w)).toBe('bob is offline');
  });
});
