// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-rename-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let buffers: typeof import('./buffers.js');
let renameBuffer: typeof import('./renameBuffer.js').renameBuffer;
let insertMessage: typeof import('./messages.js').insertMessage;
let listMessages: typeof import('./messages.js').listMessages;
let bufferReads: typeof import('./bufferReads.js');
let pinned: typeof import('./pinnedBuffers.js');
let favorites: typeof import('./favoriteBuffers.js');
let drafts: typeof import('./drafts.js');
let userId: number;
let networkId: number;

function seed(target: string, text: string): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'peer',
      text,
    }).id,
  );
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  buffers = await import('./buffers.js');
  ({ renameBuffer } = await import('./renameBuffer.js'));
  ({ insertMessage, listMessages } = await import('./messages.js'));
  bufferReads = await import('./bufferReads.js');
  pinned = await import('./pinnedBuffers.js');
  favorites = await import('./favoriteBuffers.js');
  drafts = await import('./drafts.js');
  userId = createUser('rename-alice').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'a',
  })!.id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('plain rename', () => {
  it('is one row update: same id, new name, satellites follow for free', () => {
    buffers.ensureOpen(userId, networkId, 'oldnick');
    const before = buffers.getBuffer(userId, networkId, 'oldnick')!;
    seed('oldnick', 'hello');
    bufferReads.setReadState(userId, networkId, 'oldnick', 1_000_000);
    drafts.upsertDraft(userId, networkId, 'oldnick', 'wip');

    const result = renameBuffer(userId, networkId, 'oldnick', 'newnick')!;
    expect(result).toMatchObject({
      renamed: true,
      bufferId: before.id,
      from: 'oldnick',
      to: 'newnick',
      merged: false,
    });

    // The old name is gone, the new one resolves to the SAME id.
    expect(buffers.getBuffer(userId, networkId, 'oldnick')).toBeUndefined();
    expect(buffers.getBuffer(userId, networkId, 'newnick')?.id).toBe(before.id);
    // Satellites were never name-keyed, so they simply follow.
    expect(listMessages(networkId, 'newnick').map((m) => m.text)).toEqual(['hello']);
    expect(bufferReads.getReadState(userId, networkId, 'newnick')).toBe(1_000_000);
    expect(drafts.listForUser(userId).find((d) => d.target === 'newnick')?.body).toBe('wip');
  });

  it('casing-only: adopts the display casing, same identity, no merge', () => {
    buffers.ensureOpen(userId, networkId, 'carol');
    const id = buffers.getBuffer(userId, networkId, 'carol')!.id;
    const result = renameBuffer(userId, networkId, 'carol', 'Carol')!;
    expect(result).toMatchObject({ renamed: true, merged: false, bufferId: id, to: 'Carol' });
    expect(buffers.getBuffer(userId, networkId, 'carol')?.target).toBe('Carol');
  });

  it('a true no-op (same casing) reports renamed: false', () => {
    buffers.ensureOpen(userId, networkId, 'dave');
    expect(renameBuffer(userId, networkId, 'dave', 'dave')?.renamed).toBe(false);
  });

  it('unknown source returns undefined; sentinels refuse', () => {
    expect(renameBuffer(userId, networkId, 'nobody-here', 'x')).toBeUndefined();
    expect(renameBuffer(userId, networkId, `:server:${networkId}`, 'x')?.renamed).toBe(false);
  });
});

describe('merge (a buffer already holds the new name): SOURCE survives', () => {
  it('keeps the live id, repoints history, merges pointers, unions visibility', () => {
    // The absorbed side: an old CLOSED dm under the new nick, with history,
    // a further clear marker, a pin, and a favorite.
    buffers.ensureOpen(userId, networkId, 'erin_away');
    const absorbedId = buffers.getBuffer(userId, networkId, 'erin_away')!.id;
    const oldMsg = seed('erin_away', 'ancient chat');
    bufferReads.setReadState(userId, networkId, 'erin_away', oldMsg);
    pinned.pinBuffer(userId, networkId, 'erin_away');
    favorites.favoriteBuffer(userId, networkId, 'erin_away');
    buffers.close(userId, networkId, 'erin_away');

    // The live side: the current conversation.
    buffers.ensureOpen(userId, networkId, 'erin');
    const liveId = buffers.getBuffer(userId, networkId, 'erin')!.id;
    const liveMsg = seed('erin', 'current chat');
    bufferReads.setReadState(userId, networkId, 'erin', liveMsg);
    drafts.upsertDraft(userId, networkId, 'erin', 'live draft');

    const result = renameBuffer(userId, networkId, 'erin', 'erin_away')!;
    expect(result).toMatchObject({
      renamed: true,
      merged: true,
      bufferId: liveId,
      mergedFromBufferId: absorbedId,
      to: 'erin_away',
    });

    // One buffer remains, under the live conversation's id, OPEN (union).
    const survivor = buffers.getBuffer(userId, networkId, 'erin_away')!;
    expect(survivor.id).toBe(liveId);
    expect(survivor.state).toBe('open');
    expect(db.prepare(`SELECT 1 FROM buffers WHERE id = ?`).get(absorbedId)).toBeUndefined();

    // Histories interleave (global id order) on the survivor.
    expect(listMessages(networkId, 'erin_away').map((m) => m.text)).toEqual([
      'ancient chat',
      'current chat',
    ]);
    // Furthest read pointer wins (liveMsg > oldMsg).
    expect(bufferReads.getReadState(userId, networkId, 'erin_away')).toBe(liveMsg);
    // The absorbed pin transferred to the survivor and positions are dense.
    expect(pinned.listPinnedForUserNetwork(userId, networkId)).toContain('erin_away');
    // Same for the absorbed favorite: it rides to the survivor's id.
    expect(favorites.listFavoritesForUser(userId)).toContainEqual({
      networkId,
      target: 'erin_away',
      bufferId: liveId,
    });
    // The survivor's draft wins.
    expect(drafts.getDraftForBuffer(userId, liveId)?.body).toBe('live draft');
    expect(result.draftChanged).toBe(false);
  });

  it('adopts the absorbed draft when the survivor has none, and says so', () => {
    buffers.ensureOpen(userId, networkId, 'frank2');
    drafts.upsertDraft(userId, networkId, 'frank2', 'stashed');
    buffers.ensureOpen(userId, networkId, 'frank');
    const liveId = buffers.getBuffer(userId, networkId, 'frank')!.id;

    const result = renameBuffer(userId, networkId, 'frank', 'frank2')!;
    expect(result.merged).toBe(true);
    expect(result.draftChanged).toBe(true);
    expect(drafts.getDraftForBuffer(userId, liveId)?.body).toBe('stashed');
  });
});
