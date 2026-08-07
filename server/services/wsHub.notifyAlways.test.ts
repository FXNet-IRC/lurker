// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// #679: decorateMessage's notify-always lookup is a DB point query whose
// arguments (userId + networkId + target) are identical for every row of a
// buffer. Every N-row caller hoists it; these tests pin the call COUNT, which is
// the only thing that regresses if someone later drops the argument back out of
// a .map(). A behaviour-only test cannot catch that — the naive and hoisted
// paths return the same answer, just N times instead of once.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-notify-hoist');

// Spy at the module boundary: the statement inside channelNotify.js is
// module-private, and wsHub imports the function by name, so this is the seam
// where the per-row calls are countable.
vi.mock('../db/channelNotify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/channelNotify.js')>();
  return {
    ...actual,
    getChannelNotifyAlways: vi.fn<typeof actual.getChannelNotifyAlways>(
      actual.getChannelNotifyAlways,
    ),
  };
});

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let buffers: typeof import('../db/buffers.js');
let channelNotify: typeof import('../db/channelNotify.js');
let buildBufferBacklog: typeof import('./wsHub.js').buildBufferBacklog;
let buildResumeSlice: typeof import('./wsHub.js').buildResumeSlice;

let userId: number;
let networkId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  buffers = await import('../db/buffers.js');
  channelNotify = await import('../db/channelNotify.js');
  ({ buildBufferBacklog, buildResumeSlice } = await import('./wsHub.js'));

  userId = createUser('alice').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
});

afterAll(() => testDb.cleanup());

function seed(target: string, text: string): number {
  buffers.ensureExists(userId, networkId, target);
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text,
      self: false,
    }).id,
  );
}

const spy = () => vi.mocked(channelNotify.getChannelNotifyAlways);

describe('notify-always lookups are hoisted out of N-row decorates (#679)', () => {
  it('queries once for a 25-row backlog, not once per row', () => {
    for (let i = 0; i < 25; i++) seed('#hoist', `line ${i}`);
    channelNotify.setChannelNotifyAlways(userId, networkId, '#hoist', true);
    spy().mockClear();

    const frame = buildBufferBacklog(userId, networkId, '#hoist');

    const events = frame.events as Array<{ notifyAlways?: boolean }>;
    expect(events).toHaveLength(25);
    // The answer still reaches every row...
    expect(events.every((e) => e.notifyAlways === true)).toBe(true);
    // ...from a single lookup.
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it('keeps a false answer false (the hoisted value must not fall through)', () => {
    for (let i = 0; i < 5; i++) seed('#quiet', `line ${i}`);
    spy().mockClear();

    const frame = buildBufferBacklog(userId, networkId, '#quiet');

    const events = frame.events as Array<{ notifyAlways?: boolean }>;
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.notifyAlways === false)).toBe(true);
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it('queries once per resume slice, whichever branch ships it', () => {
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) ids.push(seed('#resume', `line ${i}`));
    channelNotify.setChannelNotifyAlways(userId, networkId, '#resume', true);

    // Gap branch: everything after the 5th row.
    spy().mockClear();
    const gap = buildResumeSlice(userId, networkId, '#resume', ids[4]);
    expect(gap.events).toHaveLength(15);
    expect(gap.events.every((e) => e.notifyAlways === true)).toBe(true);
    expect(spy()).toHaveBeenCalledTimes(1);

    // Latest branch: fresh connect, no cursor.
    spy().mockClear();
    const latest = buildResumeSlice(userId, networkId, '#resume', 0);
    expect(latest.events).toHaveLength(20);
    expect(latest.events.every((e) => e.notifyAlways === true)).toBe(true);
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  // ⚠ ZERO, not "at most one". notify-always is a channel setting, and `decorateMessage`
  // short-circuits before the query for anything else — so hoisting UNCONDITIONALLY would turn no
  // queries into one for every DM and `:server:` slice, making the commonest backlog slower in
  // the name of a speedup. The guard inside `bufferNotifyAlways` is what these pin.
  it('never queries at all for a DM buffer', () => {
    for (let i = 0; i < 10; i++) seed('carol', `line ${i}`);
    spy().mockClear();

    const frame = buildBufferBacklog(userId, networkId, 'carol');

    const events = frame.events as Array<{ notifyAlways?: boolean }>;
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.notifyAlways === false)).toBe(true);
    expect(spy()).not.toHaveBeenCalled();
  });

  it('never queries at all for a :server: buffer', () => {
    for (let i = 0; i < 5; i++) seed(':server:', `line ${i}`);
    spy().mockClear();

    buildBufferBacklog(userId, networkId, ':server:');

    expect(spy()).not.toHaveBeenCalled();
  });

  // #724: notify-always is stored against any target `kindForTarget` calls a channel, but
  // decorateMessage only CONSULTED it for `#`. So on a network with `&`/`+`/`!` channels the
  // toggle stored fine, showed as on, and then never fired — the setting was inert.
  it('applies notify-always to a &-prefixed channel, not just #', () => {
    for (let i = 0; i < 4; i++) seed('&local', `line ${i}`);
    channelNotify.setChannelNotifyAlways(userId, networkId, '&local', true);
    spy().mockClear();

    const frame = buildBufferBacklog(userId, networkId, '&local');

    const events = frame.events as Array<{
      notifyAlways?: boolean;
      notify?: boolean;
      dm?: boolean;
    }>;
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.notifyAlways === true)).toBe(true);
    // And it still costs exactly one lookup, like any other channel.
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  // ⚠⚠ The assertion that makes the one above mean anything. `decorateMessage` sets
  // `dm = isDirect(event)`, which routed through a `#`-only `isDmTarget` — so an `&local` message
  // was ALREADY dm:true, `contentNotify` was already true, and widening the notify-always test
  // changed `notify` for nothing. A `notify === true` assertion passes either way and hides that.
  // The DM misclassification is also the worse bug: `isDmTarget` feeds `computeUnreadFor`, where
  // every unread line in a "DM" counts as a highlight.
  it('does not treat a &-prefixed channel as a DM', () => {
    for (let i = 0; i < 3; i++) seed('&notdm', `line ${i}`);
    const frame = buildBufferBacklog(userId, networkId, '&notdm');

    const events = frame.events as Array<{ dm?: boolean; notify?: boolean }>;
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.dm === false)).toBe(true);
    // With no notify-always set and no highlight, an ordinary channel line is not notify-worthy.
    expect(events.every((e) => e.notify === false)).toBe(true);
  });

  it('never queries for a DM resume slice either', () => {
    for (let i = 0; i < 8; i++) seed('dave', `line ${i}`);
    spy().mockClear();

    const slice = buildResumeSlice(userId, networkId, 'dave', 0);

    expect(slice.events).toHaveLength(8);
    expect(spy()).not.toHaveBeenCalled();
  });
});
