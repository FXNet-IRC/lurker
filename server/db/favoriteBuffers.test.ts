// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-favorites-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let ensureBuffer: typeof import('./buffers.js').ensureExists;
let favorites: typeof import('./favoriteBuffers.js');
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

function mkNet(userId: number, name: string) {
  return createNetwork(userId, { name, host: 'h', port: 6697, tls: true, nick: name });
}

function targets(userId: number): string[] {
  return favorites.listFavoritesForUser(userId).map((f) => f.target);
}

function idFor(networkId: number, target: string): number {
  return (
    db
      .prepare(
        `SELECT id FROM buffers WHERE user_id = ? AND network_id = ? AND target_folded = lower(?)`,
      )
      .get(user!.id, networkId, target) as { id: number }
  ).id;
}

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ ensureExists: ensureBuffer } = await import('./buffers.js'));
  favorites = await import('./favoriteBuffers.js');
  db = (await import('./index.js')).default;
  user = createUser('fav-alice');
  net = mkNet(user.id, 'libera');
  net2 = mkNet(user.id, 'oftc');
  // Favorites are keyed by buffer_id: a favorite only exists for a buffer the
  // registry knows, so the fixtures mint every target used. Mixed kinds on
  // purpose — the one global list holds channels and DMs together.
  for (const t of ['#a', '#b', 'bob', 'amy']) ensureBuffer(user.id, net!.id, t);
  ensureBuffer(user.id, net2!.id, '#meta');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('favoriteBuffer / listFavoritesForUser', () => {
  it('appends across networks in one global order and reports true on add', () => {
    expect(favorites.favoriteBuffer(user.id, net!.id, '#a')).toBe(true);
    expect(favorites.favoriteBuffer(user.id, net!.id, 'bob')).toBe(true);
    expect(favorites.favoriteBuffer(user.id, net2!.id, '#meta')).toBe(true);
    expect(favorites.listFavoritesForUser(user.id)).toEqual([
      { networkId: net!.id, target: '#a', bufferId: idFor(net!.id, '#a') },
      { networkId: net!.id, target: 'bob', bufferId: idFor(net!.id, 'bob') },
      { networkId: net2!.id, target: '#meta', bufferId: idFor(net2!.id, '#meta') },
    ]);
  });

  it('is idempotent — favoriting twice reports false and does not move the entry', () => {
    expect(favorites.favoriteBuffer(user.id, net!.id, '#a')).toBe(false);
    expect(targets(user.id)).toEqual(['#a', 'bob', '#meta']);
  });

  it('favoriting an unknown target is a no-op reporting false', () => {
    expect(favorites.favoriteBuffer(user.id, net!.id, '#never-existed')).toBe(false);
    expect(targets(user.id)).toEqual(['#a', 'bob', '#meta']);
  });

  it('refuses a CLOSED buffer (stale-tab favorite after a close elsewhere)', async () => {
    // close-buffer enforces close⇒unfavorite; a favorite racing in from a tab
    // that hasn't seen the close must not mint an invisible orphan that
    // resurrects on reopen.
    const buffers = await import('./buffers.js');
    ensureBuffer(user.id, net!.id, 'ghost');
    buffers.close(user.id, net!.id, 'ghost');
    expect(favorites.favoriteBuffer(user.id, net!.id, 'ghost')).toBe(false);
    expect(targets(user.id)).toEqual(['#a', 'bob', '#meta']);
  });

  it('resolves the target case-insensitively', () => {
    expect(favorites.favoriteBuffer(user.id, net!.id, 'BOB')).toBe(false); // already a favorite
    expect(targets(user.id)).toEqual(['#a', 'bob', '#meta']);
  });
});

describe('unfavoriteBuffer', () => {
  it('removes case-insensitively, renumbers densely, and reports true', () => {
    favorites.favoriteBuffer(user.id, net!.id, 'amy');
    expect(favorites.unfavoriteBuffer(user.id, net!.id, 'BoB')).toBe(true);
    expect(targets(user.id)).toEqual(['#a', '#meta', 'amy']);
    const positions = db
      .prepare(`SELECT position FROM favorite_buffers WHERE user_id = ? ORDER BY position`)
      .all(user.id) as Array<{ position: number }>;
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('reports false when nothing matched (broadcast is skipped)', () => {
    expect(favorites.unfavoriteBuffer(user.id, net!.id, 'bob')).toBe(false);
    expect(favorites.unfavoriteBuffer(user.id, net!.id, '#never-existed')).toBe(false);
  });
});

describe('reorderFavorites', () => {
  // State entering this block: ['#a', '#meta', 'amy'] (net, net2, net).
  it('rewrites the global order from a full id list', () => {
    const next = favorites.reorderFavorites(user.id, [
      idFor(net!.id, 'amy'),
      idFor(net2!.id, '#meta'),
      idFor(net!.id, '#a'),
    ]);
    expect(next!.map((f) => f.target)).toEqual(['amy', '#meta', '#a']);
  });

  it('a subset floats to the front; unmentioned rows keep relative order after it', () => {
    // A drag inside one kind-filtered section sends only that section's ids.
    const next = favorites.reorderFavorites(user.id, [idFor(net!.id, '#a')]);
    expect(next!.map((f) => f.target)).toEqual(['#a', 'amy', '#meta']);
  });

  it('returns null on an id that is not currently a favorite', () => {
    expect(favorites.reorderFavorites(user.id, [idFor(net!.id, 'bob')])).toBeNull();
  });

  it('returns null on a duplicated id', () => {
    const a = idFor(net!.id, '#a');
    expect(favorites.reorderFavorites(user.id, [a, a])).toBeNull();
  });

  it('null paths leave the stored order untouched', () => {
    expect(targets(user.id)).toEqual(['#a', 'amy', '#meta']);
  });
});

describe('renumberFavorites', () => {
  it('re-densifies after rows vanish mid-sequence (the network-delete cascade)', () => {
    // Simulate the cascade: delete the middle row directly.
    db.prepare(`DELETE FROM favorite_buffers WHERE user_id = ? AND buffer_id = ?`).run(
      user.id,
      idFor(net!.id, 'amy'),
    );
    favorites.renumberFavorites(user.id);
    const rows = db
      .prepare(`SELECT position FROM favorite_buffers WHERE user_id = ? ORDER BY position ASC`)
      .all(user.id) as Array<{ position: number }>;
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(targets(user.id)).toEqual(['#a', '#meta']);
  });
});

describe('cascade', () => {
  it('deleting a buffer deletes its favorite row', () => {
    const before = targets(user.id).length;
    db.prepare(`DELETE FROM buffers WHERE id = ?`).run(idFor(net2!.id, '#meta'));
    expect(targets(user.id).length).toBe(before - 1);
  });
});

describe('isFavoriteDmPeer', () => {
  it('true only for the fold-matched peer of a favorited DM buffer', () => {
    const hana = createUser('fav-hana');
    const netH = mkNet(hana.id, 'h');
    ensureBuffer(hana.id, netH!.id, 'pal');
    ensureBuffer(hana.id, netH!.id, '#chan');
    ensureBuffer(hana.id, netH!.id, 'stranger');
    favorites.favoriteBuffer(hana.id, netH!.id, 'pal');
    favorites.favoriteBuffer(hana.id, netH!.id, '#chan');

    expect(favorites.isFavoriteDmPeer(hana.id, netH!.id, 'pal')).toBe(true);
    // Fold-aware: the server relays its own casing on presence events.
    expect(favorites.isFavoriteDmPeer(hana.id, netH!.id, 'PAL')).toBe(true);
    // A favorited CHANNEL is never a person, and a non-favorite DM never gates in.
    expect(favorites.isFavoriteDmPeer(hana.id, netH!.id, '#chan')).toBe(false);
    expect(favorites.isFavoriteDmPeer(hana.id, netH!.id, 'stranger')).toBe(false);
    expect(favorites.isFavoriteDmPeer(hana.id, netH!.id, 'never-seen')).toBe(false);
  });
});

describe('favoritesChangedFrame (wsHub)', () => {
  it('ships the full global entry list — the burst seed and every correction', async () => {
    const iris = createUser('fav-iris');
    const netI = mkNet(iris.id, 'i');
    ensureBuffer(iris.id, netI!.id, '#chan');
    ensureBuffer(iris.id, netI!.id, 'pal');
    favorites.favoriteBuffer(iris.id, netI!.id, '#chan');
    favorites.favoriteBuffer(iris.id, netI!.id, 'pal');

    const { favoritesChangedFrame } = await import('../services/wsHub.js');
    const frame = favoritesChangedFrame(iris.id);
    expect(frame.kind).toBe('favorites-changed');
    expect(frame.favorites).toEqual(favorites.listFavoritesForUser(iris.id));
    expect((frame.favorites as unknown[]).length).toBe(2);
  });
});
