// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  flattenBufferOrder,
  flattenUnreadOrder,
  FRIENDS_GROUP_ID,
  FAVORITES_GROUP_ID,
} from './bufferOrder.js';

// Lightweight duck-typed fakes matching the store interfaces bufferOrder reads.
function makeBuffers(byNetwork: Record<string, string[]>, unread: Record<string, number> = {}) {
  return {
    forNetwork: (id: string | number) =>
      (byNetwork[String(id)] || []).map((target) => ({ target })),
    byKey: (key: string) => (key in unread ? { unread: unread[key] } : null),
  };
}
function makePins(byNetwork: Record<string, string[]>) {
  return { forNetwork: (id: string | number) => byNetwork[String(id)] ?? null };
}

// The activeKey of a network's server pseudo-buffer: `${id}::` + `:server:${id}`,
// i.e. a triple colon (network id, `::` separator, `:server:<id>` target).
const srvKey = (id: number) => `${id}:::server:${id}`;

describe('flattenBufferOrder', () => {
  it('orders each network: server first, pinned (stored order), then channels then DMs alphabetically', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }, { id: 2 }],
      buffers: makeBuffers({
        '1': ['#zeta', '#alpha', 'bob', 'amy', '#pinned', 'dm_pinned'],
        '2': ['#chan2'],
      }),
      pins: makePins({ '1': ['#pinned', 'dm_pinned'] }),
    });
    expect(order.map((e) => e.key)).toEqual([
      srvKey(1),
      '1::#pinned',
      '1::dm_pinned',
      '1::#alpha',
      '1::#zeta',
      '1::amy',
      '1::bob',
      srvKey(2),
      '2::#chan2',
    ]);
    // Every real entry nav-groups by its own network id.
    expect(order.every((e) => e.groupId === e.networkId)).toBe(true);
  });

  it('ignores pinned targets that no longer exist as buffers', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#real'] }),
      pins: makePins({ '1': ['#ghost', '#real'] }), // #ghost has no buffer
    });
    expect(order.map((e) => e.target)).toEqual([':server:1', '#real']);
  });

  it('injects the FRIENDS then FAVORITES sections first, under their group ids', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#chan', '#fav', 'bob'] }),
      pins: makePins({}),
      favorites: {
        friends: [{ networkId: 1, target: 'bob' }],
        channels: [{ networkId: 1, target: '#fav' }],
        excludeKeys: new Set(['1::bob', '1::#fav']),
      },
    });
    expect(order.slice(0, 2)).toEqual([
      { networkId: 1, target: 'bob', key: '1::bob', groupId: FRIENDS_GROUP_ID },
      { networkId: 1, target: '#fav', key: '1::#fav', groupId: FAVORITES_GROUP_ID },
    ]);
    // Favorited buffers are excluded from their real network so they aren't
    // walked twice.
    expect(order.filter((e) => e.groupId === 1).map((e) => e.target)).toEqual([
      ':server:1',
      '#chan',
    ]);
  });

  it('excludeKeys matching is case-insensitive on the target', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['Bob'] }), // server-cased nick
      pins: makePins({}),
      favorites: {
        friends: [{ networkId: 1, target: 'Bob' }],
        channels: [],
        excludeKeys: new Set(['1::bob']),
      },
    });
    // Only the friends-section Bob remains; the real-network one is excluded.
    expect(order.filter((e) => e.groupId === 1).map((e) => e.target)).toEqual([':server:1']);
  });

  it('excludes favorited pins from the pinned walk too', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#fav', '#pinned'] }),
      pins: makePins({ '1': ['#fav', '#pinned'] }),
      favorites: {
        friends: [],
        channels: [{ networkId: 1, target: '#fav' }],
        excludeKeys: new Set(['1::#fav']),
      },
    });
    expect(order.map((e) => e.key)).toEqual(['1::#fav', srvKey(1), '1::#pinned']);
  });
});

// #724: the sidebar sorted channels before DMs using a bare `#` test, so an `&`/`+`/`!` channel
// filed among the DMs — and its sort key kept the sigil, so it sorted under punctuation instead
// of by name.
describe('non-# channels sort as channels', () => {
  it('puts &, + and ! channels in the channel block, before DMs', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['bob', '&local', '#zeta', '+nomodes', 'amy', '!ABCDEsafe'] }),
      pins: makePins({}),
    });
    expect(order.map((e) => e.key)).toEqual([
      srvKey(1),
      // Channels, alphabetical by name with the sigil stripped:
      // ABCDEsafe, local, nomodes, zeta
      '1::!ABCDEsafe',
      '1::&local',
      '1::+nomodes',
      '1::#zeta',
      // …then the DMs.
      '1::amy',
      '1::bob',
    ]);
  });

  it('sorts &local by its name, adjacent to #local', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#apple', '&banana', '#cherry'] }),
      pins: makePins({}),
    });
    // Sigil-blind alphabetical: apple, banana, cherry. With the old `/^#+/` strip, `&banana`
    // sorted on the literal `&` and led the list.
    expect(order.map((e) => e.key)).toEqual([srvKey(1), '1::#apple', '1::&banana', '1::#cherry']);
  });
});

describe('flattenUnreadOrder', () => {
  it('keeps only entries whose buffer has unread > 0, server pseudo-buffers included', () => {
    const args = {
      networks: [{ id: 1 }],
      buffers: makeBuffers(
        { '1': ['#busy', '#quiet'] },
        { '1::#busy': 3, '1::#quiet': 0, [srvKey(1)]: 1 },
      ),
      pins: makePins({}),
    };
    expect(flattenUnreadOrder(args).map((e) => e.key)).toEqual([srvKey(1), '1::#busy']);
  });
});
