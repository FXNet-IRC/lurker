// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A DCC chat offer surfaces as a STICKY toast (#270). Normally the live
// `dcc-chat-offer-closed` event retires it — but that event can be missed: the
// tab's socket drops, or the server restarts, while an offer is pending. Then
// the toast outlives its offer, and its Accept button quietly sends the peer a
// FRESH offer, a different act than the one it names. Every snapshot carries
// the offers still pending, and these drive real frames through the socket's
// message listener to prove the toast reconciles against it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useLinkPreview.js', () => ({
  primePreviews: vi.fn<(texts: unknown[], toggles: unknown) => void>(),
  previewRevision: { value: 0 },
}));

// Records listeners so a test can deliver frames exactly as the browser would.
const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {}
  send(): void {}
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import { useSocket, resetPreviewToggleWiring, resetSocket } from './useSocket.js';
import { useToastsStore } from '../stores/toasts.js';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

// A network's snapshot blob, carrying only what these tests turn on.
function netSnapshot(dccChatOffers: string[]) {
  return {
    networkId: 1,
    state: 'connected',
    channels: [],
    peerPresence: {},
    pinned: [],
    collapsedNicklists: {},
    channelNotify: {},
    ignoredMasks: [],
    nickNotes: [],
    relayBots: [],
    dccChats: [],
    dccChatOffers,
  };
}

const offerFrame = {
  kind: 'irc',
  type: 'dcc-chat-offer',
  networkId: 1,
  target: ':server:1',
  from: 'bob',
  passive: false,
};

const offerToasts = () => useToastsStore().items.filter((t) => t.title === 'DCC chat from bob');

async function openSocket(): Promise<FakeWebSocket> {
  mount(RouteView);
  await nextTick();
  return sockets.at(-1)!;
}

describe('DCC chat offer toast — reconciled against every snapshot', () => {
  beforeEach(() => {
    resetSocket(); // the socket is a module-level singleton
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // Applying a snapshot starts API fetches in other stores. Left pending,
    // happy-dom aborts them at teardown and prints AbortErrors that would bury
    // a real failure; settling them keeps the output honest.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    setActivePinia(createPinia());
    resetPreviewToggleWiring();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetPreviewToggleWiring();
  });

  it('shows the offer as a toast', async () => {
    const ws = await openSocket();
    ws.deliver(offerFrame);
    expect(offerToasts()).toHaveLength(1);
  });

  // The case the review caught: the close event never arrived, so only the
  // next snapshot can say the offer is gone.
  it('retires the toast when a snapshot no longer lists the offer', async () => {
    const ws = await openSocket();
    ws.deliver(offerFrame);
    expect(offerToasts()).toHaveLength(1);

    ws.deliver({ kind: 'snapshot', networks: [netSnapshot([])] });
    expect(offerToasts()).toHaveLength(0);
  });

  // …and must leave a still-pending offer alone, or every reconnect would
  // throw away an offer the user hasn't answered yet.
  it('keeps the toast while the snapshot still lists the offer', async () => {
    const ws = await openSocket();
    ws.deliver(offerFrame);
    ws.deliver({ kind: 'snapshot', networks: [netSnapshot(['bob'])] });
    expect(offerToasts()).toHaveLength(1);
  });

  it('matches the peer case-insensitively', async () => {
    const ws = await openSocket();
    ws.deliver(offerFrame);
    ws.deliver({ kind: 'snapshot', networks: [netSnapshot(['BOB'])] });
    expect(offerToasts()).toHaveLength(1);
  });
});
