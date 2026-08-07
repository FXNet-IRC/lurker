// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// ⚠ Signatures are asserted against bytes sharp ACTUALLY PRODUCES, not against a
// table of magic numbers copied out of a reference and back into a test. A
// hand-written fixture agrees with a hand-written parser by construction — it
// proves the two were typed from the same source, which is the one thing never in
// doubt. The formats sharp can emit here are generated; the rest are the smallest
// real headers of their kind.

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { imageSignatureOf, SIGNATURE_BYTES } from './imageSignature.js';

const raw = (channels: 3 | 4 = 3) =>
  sharp({ create: { width: 8, height: 8, channels, background: { r: 1, g: 2, b: 3 } } });

describe('imageSignatureOf', () => {
  it('recognises what sharp encodes, from the first bytes alone', async () => {
    const made: Array<[string, Buffer]> = [
      ['image/png', await raw().png().toBuffer()],
      ['image/jpeg', await raw().jpeg().toBuffer()],
      ['image/gif', await raw().gif().toBuffer()],
      ['image/webp', await raw().webp().toBuffer()],
      ['image/webp', await raw(4).webp().toBuffer()], // VP8X (alpha) — a different chunk
      ['image/avif', await raw().avif().toBuffer()],
      ['image/tiff', await raw().tiff().toBuffer()],
    ];
    for (const [want, buf] of made) {
      // ⚠ Sliced to the header, because that is all the caller ever keeps.
      const head = buf.subarray(0, SIGNATURE_BYTES);
      expect(`${want}: ${imageSignatureOf(head)}`).toBe(`${want}: ${want}`);
    }
  });

  it('refuses documents wearing an image content type', () => {
    // ⚠⚠ The whole reason this module exists. Each of these can be served with
    // `Content-Type: image/png` by an origin someone else controls.
    const hostile: Array<[string, string]> = [
      ['html', '<!DOCTYPE html><html><script>alert(1)</script></html>'],
      ['bare script', '<script>alert(1)</script>'],
      // ⚠ SVG is the one the resolver already refuses by name. It has no
      // signature, so it can never match here either — an independent second no.
      ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['svg with xml prolog', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['json', '{"not":"an image"}'],
      ['plain text', 'just some text, honestly'],
      ['empty', ''],
    ];
    for (const [label, body] of hostile) {
      const got = imageSignatureOf(Buffer.from(body, 'utf8').subarray(0, SIGNATURE_BYTES));
      expect(`${label}: ${got}`).toBe(`${label}: null`);
    }
  });

  it('distinguishes HEIF from HEIC rather than collapsing both', () => {
    // ⚠ `mif1`/`msf1` are the generic ISO brands — the container without the HEVC
    // codec claim — and this codebase already tells the two apart
    // (`contentClass.ts`, `imagePipeline.ts`). The distinction is inert while the
    // only caller uses this as a yes/no gate, which is precisely why an untested
    // wrong answer would have survived to surprise the first caller that reads it.
    const ftyp = (brand: string) =>
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from('ftyp', 'latin1'),
        Buffer.from(brand, 'latin1'),
        Buffer.alloc(4),
      ]);
    for (const [brand, want] of [
      ['heic', 'image/heic'],
      ['heix', 'image/heic'],
      ['mif1', 'image/heif'],
      ['msf1', 'image/heif'],
      ['avif', 'image/avif'],
      ['avis', 'image/avif'],
    ] as const) {
      expect(`${brand} -> ${imageSignatureOf(ftyp(brand))}`).toBe(`${brand} -> ${want}`);
    }
  });

  it('refuses a RIFF container that is not WebP, and an ftyp that is not an image', () => {
    // ⚠ RIFF carries WAV and AVI too, and the ISO base-media `ftyp` box carries
    // MP4 video. Matching on the outer container alone would call both an image.
    const riffWav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(4),
    ]);
    expect(imageSignatureOf(riffWav)).toBeNull();

    const mp4 = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftyp', 'latin1'),
      Buffer.from('isom', 'latin1'),
      Buffer.alloc(4),
    ]);
    expect(imageSignatureOf(mp4)).toBeNull();
  });

  it('does not match a truncated signature', () => {
    // Nothing shorter than a signature is an image, and answering "maybe" would
    // defeat the gate — the caller treats a match as permission to store.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(imageSignatureOf(png)).toBeNull();
    expect(imageSignatureOf(Buffer.alloc(0))).toBeNull();
  });

  it('reads a real ICO and BMP header', () => {
    // Not sharp-encodable, so these are the genuine fixed headers of each format.
    expect(imageSignatureOf(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]))).toBe(
      'image/x-icon',
    );
    expect(imageSignatureOf(Buffer.from('BM', 'latin1'))).toBe('image/bmp');
  });
});
