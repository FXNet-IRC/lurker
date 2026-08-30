// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The two facts the resolver, the byte routes and the byte cache all judge by,
// in a leaf module so any of them can ask without importing each other. This
// used to live in linkPreview.ts, where the byte cache had to reach it through
// an import that was one step from a cycle — and the resolver now needs the byte
// cache (to store poster frames), which would have closed it.

import type { PreviewKind } from '../db/linkPreviews.js';

/**
 * What a Content-Type means for rendering.
 *
 * SVG is deliberately absent from the image branch. It is a document format that
 * executes script, not a picture — the uploader already refuses it (#553-era
 * media scrubbing), and letting one in here would reintroduce the same hole
 * through a different door.
 *
 * ⚠⚠ ONE definition, asked by everyone — `cacheable()`, the byte route, descriptor
 * minting. `image/svg+xml` is refused here and nowhere else, and a duplicated rule
 * is how it nearly got served under our own origin once already.
 *
 * ⚠ The lurker-previews decoder keeps its own copy (its resolve.ts) — one of the
 * two deliberate cross-repo duplications in the isolation plan. Drift fails
 * CLOSED: a kind either side doesn't recognise is refused, not guessed at.
 */
export function kindForContentType(contentType: string): PreviewKind | null {
  if (contentType === 'image/svg+xml') return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'page';
  return null;
}

/** Ceiling on preview IMAGE bytes the proxy will serve — the only kind it relays at all.
 *  The decoder enforces the same figure at the origin side; this one is what the byte
 *  cache reserves against and what the route holds a skewed decoder to. */
export const MAX_IMAGE_PROXY_BYTES = 8 * 1024 * 1024;

/**
 * Whether the byte proxy will serve this content type.
 *
 * ⚠⚠ IMAGES ONLY, as of the media-policy change — video and audio are not relayed at
 * any size. `toDescriptor` stops minting byte URLs for those kinds, so nothing should
 * ask; this is the enforcement point, and it has to refuse a replayed token from a
 * client holding an older descriptor.
 */
export function proxyableContentType(contentType: string): boolean {
  return kindForContentType(contentType) === 'image';
}
