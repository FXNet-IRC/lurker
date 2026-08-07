// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What an image's first bytes say it actually is.
//
// ⚠⚠ This exists because a Content-Type is a CLAIM, and everywhere else in the
// preview path we were treating it as a fact. `kindForContentType` tests
// `contentType.startsWith('image/')` against what the origin asserted; nothing
// looked at the body. So an origin under someone else's control can answer
// `Content-Type: image/png` with an HTML document, and — before this — we would
// cache those bytes verbatim and later serve them back under our own name, or
// from a bucket, with `Content-Disposition: inline`.
//
// ⚠ This is a GATE, not a correction. It answers "are these bytes a raster image
// at all", and the caller refuses to cache when they are not. It deliberately
// does NOT rewrite the stored Content-Type to the detected one: an origin that
// labels a real PNG as `image/jpeg` is mislabelling something harmless, browsers
// decode by magic bytes regardless, and the UNCACHED path passes the origin's
// header through untouched — so correcting it only on the cached path would make
// the first load and the second load disagree for no benefit.
//
// ⚠ Sniffing rather than sharp, deliberately. sharp is the better answer for
// DIMENSIONS and is used for that (`imageDimensions`), but it refuses several
// containers outright when handed fewer bytes than their header claims — webp,
// gif and tiff all throw on a truncated read, as `imageHeader.ts` documents at
// length. A gate built on it would refuse to cache exactly the formats most
// ordinary to paste into IRC. A signature is a fixed-offset fact and cannot be
// truncated out of existence.
//
// ⚠ SVG has no signature and can never match here, which is the correct outcome
// twice over: it is the one format `kindForContentType` already refuses by name —
// "a scripting format wearing a picture's clothes" — and a second, independent
// refusal for it is exactly the belt-and-braces this module is for.

/** Enough for every signature below; AVIF's brand is the deepest, at byte 12. */
export const SIGNATURE_BYTES = 16;

const ASCII = (buf: Buffer, start: number, end: number): string =>
  buf.length >= end ? buf.toString('latin1', start, end) : '';

const starts = (buf: Buffer, bytes: number[]): boolean =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/**
 * ISO base-media brands we are willing to call an image.
 *
 * ⚠ An allowlist, not "anything with an ftyp box". The same container carries
 * MP4 video, and this module's answer decides what gets stored as a picture.
 */
const IMAGE_BRANDS = new Map<string, string>([
  ['avif', 'image/avif'],
  ['avis', 'image/avif'],
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['heim', 'image/heic'],
  ['heis', 'image/heic'],
  // ⚠ HEIF, not HEIC. The generic ISO brands are the container without the HEVC
  // codec claim, and this codebase already distinguishes the two
  // (`contentClass.ts`, `imagePipeline.ts`). Collapsing them was inert while the
  // only caller uses this as a yes/no gate — which is exactly why it would have
  // survived to surprise the first caller that reads the value. (Copilot.)
  ['mif1', 'image/heif'],
  ['msf1', 'image/heif'],
]);

/**
 * The image type these bytes really are, or null.
 *
 * Needs only the first `SIGNATURE_BYTES`; a short buffer simply fails to match,
 * which is the safe direction — nothing smaller than a signature is an image.
 */
export function imageSignatureOf(head: Buffer): string | null {
  // PNG, and APNG, which shares the signature and differs only in later chunks.
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // JPEG — SOI plus the first marker byte.
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const gif = ASCII(head, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  // WebP is a RIFF container; the form type at byte 8 is what distinguishes it
  // from the many other things RIFF carries (WAV, AVI).
  if (ASCII(head, 0, 4) === 'RIFF' && ASCII(head, 8, 12) === 'WEBP') return 'image/webp';
  if (ASCII(head, 4, 8) === 'ftyp') {
    const brand = IMAGE_BRANDS.get(ASCII(head, 8, 12));
    if (brand) return brand;
  }
  if (ASCII(head, 0, 2) === 'BM') return 'image/bmp';
  // TIFF, both endiannesses. Rare inline, but harmless and trivially recognised.
  if (starts(head, [0x49, 0x49, 0x2a, 0x00]) || starts(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  if (starts(head, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return null;
}
