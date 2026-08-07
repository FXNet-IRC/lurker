// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-pinned-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let ensureBuffer: typeof import('./buffers.js').ensureExists;
let pinned: typeof import('./pinnedBuffers.js');
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

function mkNet(userId: number, name: string) {
  return createNetwork(userId, { name, host: 'h', port: 6697, tls: true, nick: name });
}

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ ensureExists: ensureBuffer } = await import('./buffers.js'));
  pinned = await import('./pinnedBuffers.js');
  db = (await import('./index.js')).default;
  user = createUser('pin-alice');
  net = mkNet(user.id, 'libera');
  net2 = mkNet(user.id, 'oftc');
  // Pins are keyed by buffer_id (schema 18): a pin only exists for a buffer
  // the registry knows, so the fixtures mint every target used.
  for (const t of ['#a', '#b', '#c', '#d']) ensureBuffer(user.id, net!.id, t);
  ensureBuffer(user.id, net2!.id, '#meta');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('pinBuffer / listPinnedForUserNetwork', () => {
  it('appends in pin order', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    pinned.pinBuffer(user.id, net!.id, '#b');
    pinned.pinBuffer(user.id, net!.id, '#c');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });

  it('is idempotent — pinning twice does not duplicate or move the entry', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });

  it('pinning an unknown target is a no-op', () => {
    expect(pinned.pinBuffer(user.id, net!.id, '#never-existed')).toEqual(['#a', '#b', '#c']);
  });
});

describe('unpinBuffer', () => {
  it('densely renumbers remaining rows so positions stay 0..n-1', () => {
    pinned.unpinBuffer(user.id, net!.id, '#b');
    // Re-listing returns the new order; reorderPins relies on dense positions.
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#c']);
    // Pinning a fourth then unpinning the head exercises a non-trivial renumber.
    pinned.pinBuffer(user.id, net!.id, '#d');
    pinned.unpinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#c', '#d']);
  });
});

describe('reorderPins', () => {
  it('rewrites order on a matching set', () => {
    const next = pinned.reorderPins(user.id, net!.id, ['#d', '#c']);
    expect(next).toEqual(['#d', '#c']);
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#d', '#c']);
  });

  it('returns null when a requested target is not pinned', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#c', '#missing'])).toBeNull();
  });

  it('returns null on a duplicated target', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#d'])).toBeNull();
  });

  it('returns null on two casings of the same pin (they resolve to one buffer)', () => {
    // Pre-normalization these were distinct raw strings and failed the
    // membership check by luck of exact matching; now they resolve to the
    // same buffer_id and fail the duplicate check deliberately.
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#D'])).toBeNull();
  });

  // The client drops pins it can't render (closed/parted buffers, friend
  // primary DMs), so a drag legitimately reorders only a subset of the pinned
  // set. The reorder must still apply, keeping the unmentioned ("hidden") pins
  // after the visible ones rather than snapping back (issue #405).
  it('accepts a subset, reordering the supplied targets and keeping hidden pins after them', () => {
    // Fresh user/network so the suite-wide ordering above stays intact.
    const carol = createUser('pin-carol');
    const netC = mkNet(carol.id, 'c');
    for (const t of ['#visibleA', 'hiddenDM', '#visibleB']) ensureBuffer(carol.id, netC!.id, t);
    pinned.pinBuffer(carol.id, netC!.id, '#visibleA'); // pos 0
    pinned.pinBuffer(carol.id, netC!.id, 'hiddenDM'); // pos 1 (invisible to the client)
    pinned.pinBuffer(carol.id, netC!.id, '#visibleB'); // pos 2

    // Client only sees the two channels and drags B above A.
    const next = pinned.reorderPins(carol.id, netC!.id, ['#visibleB', '#visibleA']);
    expect(next).toEqual(['#visibleB', '#visibleA', 'hiddenDM']);
    expect(pinned.listPinnedForUserNetwork(carol.id, netC!.id)).toEqual([
      '#visibleB',
      '#visibleA',
      'hiddenDM',
    ]);
  });
});

describe('unpinBufferCaseInsensitive', () => {
  it('removes a pin whose stored casing differs from the requested target', () => {
    const dave = createUser('pin-dave');
    const netD = mkNet(dave.id, 'd');
    ensureBuffer(dave.id, netD!.id, '#Channel'); // canonical casing: capital C
    ensureBuffer(dave.id, netD!.id, '#other');
    pinned.pinBuffer(dave.id, netD!.id, '#Channel');
    pinned.pinBuffer(dave.id, netD!.id, '#other');

    // close-buffer arrives with the server's lowercased casing.
    const next = pinned.unpinBufferCaseInsensitive(dave.id, netD!.id, '#channel');
    expect(next).toEqual(['#other']);
    expect(pinned.listPinnedForUserNetwork(dave.id, netD!.id)).toEqual(['#other']);
  });

  it('case variants resolve to ONE pin — a twin row is unrepresentable', () => {
    // Pre-normalization the raw-string PRIMARY KEY let '#Channel' and
    // '#channel' coexist as separate pin rows, and this function existed to
    // sweep all of them. Under (user_id, buffer_id) keying the second pin is
    // the same buffer, so it's an idempotent no-op, and one unpin (any
    // casing) clears it with positions staying dense.
    const frank = createUser('pin-frank');
    const netF = mkNet(frank.id, 'f');
    ensureBuffer(frank.id, netF!.id, '#Channel');
    ensureBuffer(frank.id, netF!.id, '#kept');
    pinned.pinBuffer(frank.id, netF!.id, '#Channel');
    pinned.pinBuffer(frank.id, netF!.id, '#channel'); // same buffer — no-op
    pinned.pinBuffer(frank.id, netF!.id, '#kept');
    expect(pinned.listPinnedForUserNetwork(frank.id, netF!.id)).toEqual(['#Channel', '#kept']);

    const next = pinned.unpinBufferCaseInsensitive(frank.id, netF!.id, '#CHANNEL');
    expect(next).toEqual(['#kept']);
    const rows = db
      .prepare(
        `SELECT b.target AS target, p.position AS position
         FROM pinned_buffers p JOIN buffers b ON b.id = p.buffer_id
         WHERE p.user_id = ? AND p.network_id = ?`,
      )
      .all(frank.id, netF!.id) as Array<{ target: string; position: number }>;
    expect(rows).toEqual([{ target: '#kept', position: 0 }]);
  });

  it('returns null when nothing matches so the caller can skip the broadcast', () => {
    const erin = createUser('pin-erin');
    const netE = mkNet(erin.id, 'e');
    ensureBuffer(erin.id, netE!.id, '#kept');
    ensureBuffer(erin.id, netE!.id, '#nope'); // exists but isn't pinned
    pinned.pinBuffer(erin.id, netE!.id, '#kept');
    expect(pinned.unpinBufferCaseInsensitive(erin.id, netE!.id, '#nope')).toBeNull();
    expect(pinned.unpinBufferCaseInsensitive(erin.id, netE!.id, '#gone')).toBeNull();
    expect(pinned.listPinnedForUserNetwork(erin.id, netE!.id)).toEqual(['#kept']);
  });
});

describe('listPinnedForUser', () => {
  it('groups by network id', () => {
    pinned.pinBuffer(user.id, net2!.id, '#meta');
    const grouped = pinned.listPinnedForUser(user.id);
    expect(grouped.get(net!.id)).toEqual(['#d', '#c']);
    expect(grouped.get(net2!.id)).toEqual(['#meta']);
  });
});

// The schemaVersion < 7 orphan-cleanup replay that used to live here is gone
// with the name-keyed schema: that repair runs only on legacy databases (gated
// on the retired closed_buffers table existing, always before the v18 rebuild
// reshapes pinned_buffers), and its SQL cannot execute against the buffer_id
// schema. The migration path itself is covered by the v15-fixture migration
// tests.

describe('listPinnedWithIds — the pins-changed dual payload', () => {
  it('stays parallel-indexed with the name list across pin/unpin/reorder', async () => {
    const grace = createUser('pin-grace');
    const netG = mkNet(grace.id, 'g');
    for (const t of ['#one', '#two', '#three']) ensureBuffer(grace.id, netG!.id, t);
    pinned.pinBuffer(grace.id, netG!.id, '#one');
    pinned.pinBuffer(grace.id, netG!.id, '#two');
    pinned.pinBuffer(grace.id, netG!.id, '#three');

    const buffers = await import('./buffers.js');
    const check = () => {
      // The two wire arrays are one read: names in position order, and each
      // row's id must be the id of the SAME-INDEX name — the property the
      // pins-changed frame's parallel-indexing contract rests on.
      const rows = pinned.listPinnedWithIds(grace.id, netG!.id);
      expect(rows.map((r) => r.target)).toEqual(
        pinned.listPinnedForUserNetwork(grace.id, netG!.id),
      );
      for (const row of rows) {
        expect(buffers.getBuffer(grace.id, netG!.id, row.target)!.id).toBe(row.bufferId);
      }
    };

    check();
    pinned.reorderPins(grace.id, netG!.id, ['#three', '#one', '#two']);
    check();
    pinned.unpinBuffer(grace.id, netG!.id, '#one');
    check();
    expect(pinned.listPinnedForUserNetwork(grace.id, netG!.id)).toEqual(['#three', '#two']);
  });
});

describe('pinsChangedFrame (wsHub)', () => {
  it('ships pinned[] and pinnedIds[] parallel-indexed from one read', async () => {
    const henry = createUser('pin-henry');
    const netH = mkNet(henry.id, 'h');
    for (const t of ['#a', '#b']) ensureBuffer(henry.id, netH!.id, t);
    pinned.pinBuffer(henry.id, netH!.id, '#a');
    pinned.pinBuffer(henry.id, netH!.id, '#b');

    const { pinsChangedFrame } = await import('../services/wsHub.js');
    const buffers = await import('./buffers.js');
    const frame = pinsChangedFrame(henry.id, netH!.id);
    expect(frame.kind).toBe('pins-changed');
    expect(frame.pinned).toEqual(['#a', '#b']);
    expect(frame.pinnedIds).toEqual([
      buffers.getBuffer(henry.id, netH!.id, '#a')!.id,
      buffers.getBuffer(henry.id, netH!.id, '#b')!.id,
    ]);
  });
});
