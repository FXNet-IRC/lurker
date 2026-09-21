// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { canDisconnect, useNetworksStore } from './networks.js';

// The predicate behind every "Disconnect ⟷ Reconnect" control (the network context
// menu and both chat views' server-buffer headers). It is one function precisely so
// those three can't drift back apart.
describe('canDisconnect — which action a network state needs', () => {
  it('offers Disconnect while a network is on the wire', () => {
    expect(canDisconnect('connected')).toBe(true);
  });

  // ⚠⚠ The whole of #785. The retry ladder is unbounded, and it keeps its
  // IrcConnection for the entire outage — so a network pinned against a dead server
  // sits in 'reconnecting' indefinitely. Testing for 'connected' left Reconnect as
  // the only offered action, and Reconnect routes through restartNetwork: it tears
  // the connection down and starts a FRESH loop. There was no reachable stop.
  it('offers Disconnect during a reconnect backoff, which is what stops the loop', () => {
    expect(canDisconnect('reconnecting')).toBe(true);
  });

  // ⚠⚠ Not 'connecting', though it is equally "Lurker is working on it". setState('connecting')
  // fires the moment the socket opens — tens of milliseconds after the POST, well inside a
  // double-click — so a user who clicks Reconnect and impatiently clicks again would hit a
  // button that had already relabelled itself Disconnect and tear down the connection they just
  // asked for. Offering Reconnect there re-fires restartNetwork, which is harmless.
  it('offers Reconnect during a connect, so an impatient double-click is idempotent', () => {
    expect(canDisconnect('connecting')).toBe(false);
  });

  it('offers Reconnect once the network is actually down', () => {
    expect(canDisconnect('disconnected')).toBe(false);
  });

  // A network we have never heard a state for reads as "connect it", not "stop it".
  it('offers Reconnect for an unknown state', () => {
    expect(canDisconnect(undefined)).toBe(false);
    expect(canDisconnect(null)).toBe(false);
    expect(canDisconnect('')).toBe(false);
  });
});

// ⚠⚠ QA: disconnecting the network rendered "=ami|shellter is offline" in a DCC
// chat the user could still type into. A down network's cached presence rows are
// stale, so peerFor synthesizes 'offline' for any nick — correct for a real DM
// peer, exactly backwards for a DCC chat, whose socket is peer-to-peer and keeps
// working while IRC is down. Fixed in the getter rather than in each of the
// sidebar, status bar and profile, because this is where all three agree.
describe('peerFor — a DCC chat target has no presence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function store(state: string) {
    const s = useNetworksStore();
    s.states[1] = { state } as never;
    return s;
  }

  it('reports no presence for a =nick target on a disconnected network', () => {
    expect(store('disconnected').peerFor(1, '=ami|shellter')).toBeNull();
  });

  it('reports no presence for a =nick target on a connected one either', () => {
    expect(store('connected').peerFor(1, '=bob')).toBeNull();
  });

  // The synthetic offline is still right for a real DM peer — that is the whole
  // point of the getter, and this is what keeps the fix honest.
  it('still reports a real DM peer offline while the network is down', () => {
    expect(store('disconnected').peerFor(1, 'bob')).toMatchObject({ state: 'offline' });
  });
});
