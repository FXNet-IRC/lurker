// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The mint decision for every remote backend. A leaf module (below the resolver
// in the import graph) because `toDescriptor` has to call it and ./index.ts
// imports the resolver — the same cycle rule that once put this function in the
// s3 module. It moved here when the dropper backend arrived: which backend can
// mint a public URL is a dispatch, not an s3 fact.

import { peekCached } from '../../db/previewCache.js';
import { byteCacheKey, cacheConfig, expired } from './config.js';
import { publicUrl as s3PublicUrl } from './s3.js';
import { publicDropperUrl } from './dropper.js';

/**
 * The public URL for a cached image, or null to use the proxy.
 *
 * ⚠⚠ THIS IS THE WHOLE POINT OF THE REMOTE MODES, and it is the reason there is
 * no redirect anywhere in this feature. `toDescriptor` mints `src`/`thumb` per
 * request and clients treat both as opaque, so the cheapest place to send a reader
 * to the CDN is at MINT time: no 302, no second round trip through the cell, and
 * no chance of a client forwarding its `Authorization` header to a third-party
 * host, which is what a redirect would have invited.
 *
 * ⚠ Returning null is always SAFE, and that property is what makes this
 * comfortable. The caller falls back to the proxy path, which works regardless of
 * cache state — an empty bucket, a stale index, a mode change mid-flight all
 * degrade to exactly the behaviour that shipped before any of this existed. The
 * one shape that CANNOT self-correct is minting a URL for an object that is not
 * there: the client fetches the CDN directly, so its 404 never reaches us. That is
 * why the age bound is enforced here and not only on the read path.
 *
 * ⚠ `peekCached`, never `lookupCached`: this runs once per image per resolve, and
 * once per image per row once Part 2's `previewsForTexts` ships it into snapshot
 * building. The `last_access` touch is a WAL write on the shared connection.
 *
 * ⚠ Never throws — same promise the rest of the cache makes. It sits in the middle
 * of `toDescriptor`, which has no business failing because a cache lookup did.
 */
export function publicByteUrl(imageUrl: string): string | null {
  try {
    const cfg = cacheConfig();
    if (cfg.mode !== 's3' && cfg.mode !== 'dropper') return null;

    const key = byteCacheKey(imageUrl);
    const entry = peekCached(key);
    if (!entry || entry.backend !== cfg.mode || expired(entry.createdAt)) return null;
    return cfg.mode === 's3' ? s3PublicUrl(cfg, key) : publicDropperUrl(cfg, key);
  } catch {
    return null;
  }
}
