// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-mediascrub-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

/** An ISO-BMFF box: [size][type][payload]. */
function box(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
}

/** An mvhd (version 0) whose creation/modification times are set — a real muxer
 *  writes these, and "when was this recorded" is metadata too. */
function mvhd(creation: number): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt8(0, 0); // version 0
  p.writeUInt32BE(creation, 4); // creation_time
  p.writeUInt32BE(creation, 8); // modification_time
  p.writeUInt32BE(1000, 12); // timescale — must survive
  p.writeUInt32BE(5000, 16); // duration  — must survive
  return box('mvhd', p);
}

/** GPS, the thing we actually care about: QuickTime stores it in moov/udta/©xyz. */
const GPS = '+37.7749-122.4194/';
function udtaWithGps(): Buffer {
  const xyz = box('©xyz', Buffer.concat([Buffer.from([0x00, 0x12, 0x15, 0xc7]), Buffer.from(GPS)]));
  const make = box('©mak', Buffer.from('Apple'));
  return box('udta', Buffer.concat([xyz, make]));
}

function mp4WithGps(creation = 0xe679e672): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
  );
  const moov = box('moov', Buffer.concat([mvhd(creation), udtaWithGps()]));
  const mdat = box('mdat', Buffer.alloc(2048, 0xab)); // the payload we must not touch
  return Buffer.concat([ftyp, moov, mdat]);
}

/** A version-0 tkhd/mdhd. Both put creation/modification immediately after the
 *  version+flags word, at the same offsets mvhd does — which is the whole reason one
 *  zeroTimestamps() handles all three. */
function timestamped(type: string, creation: number): Buffer {
  const p = Buffer.alloc(32);
  p.writeUInt8(0, 0); // version 0
  p.writeUInt32BE(creation, 4); // creation_time
  p.writeUInt32BE(creation, 8); // modification_time
  p.writeUInt32BE(0x5eed, 12); // the field after them — must survive
  return box(type, p);
}

/**
 * What Samsung's stock voice recorder actually writes. Box layout, brand, and the
 * metadata strings below are taken from a real Galaxy recording; the audio is filler.
 *
 * Two things here are NOT arbitrary. `mdat` comes BEFORE `moov`, which is how the real
 * files are laid out and means the walker has to step over the whole payload by its
 * declared length to reach the metadata — the other fixtures put `moov` first and
 * never exercise that. And the metadata lives in a Java-serialized blob (`aced 0005`)
 * inside `udta`, plus a `meta` box holding the Android version and a UTC offset.
 *
 * Synthesized rather than committed: the real file is somebody's voice, and a fixture
 * whose entire point is "this container carries identifying metadata" is the last
 * thing that belongs in a public repo.
 */
const SAMSUNG_METADATA = [
  'com.sec.android.app.voicenote.common.util.VoiceRecorderData',
  'com.sec.android.app.voicenote.common.util.MeetingData',
  'com.android.version',
  'com.samsung.android.utc_offset',
  '-0400', // the recorder's timezone — the most identifying thing in the file
];
const SAMSUNG_MDAT_BYTES = 2048;

function samsungVoiceMemo(creation = 0xe6972a18): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from('3gp4'), Buffer.alloc(4), Buffer.from('isom'), Buffer.from('3gp4')]),
  );
  const mdat = box('mdat', Buffer.alloc(SAMSUNG_MDAT_BYTES, 0xcd));
  const java = Buffer.from([0xac, 0xed, 0x00, 0x05]); // Java serialization magic
  const udta = box(
    'udta',
    Buffer.concat([
      box('vrdt', Buffer.concat([java, Buffer.from(SAMSUNG_METADATA[0])])),
      box('metd', Buffer.concat([java, Buffer.from(SAMSUNG_METADATA[1])])),
    ]),
  );
  const meta = box(
    'meta',
    Buffer.concat([
      Buffer.alloc(4), // FullBox version+flags
      Buffer.from(SAMSUNG_METADATA[2]),
      Buffer.from(SAMSUNG_METADATA[3]),
      Buffer.from(SAMSUNG_METADATA[4]),
    ]),
  );
  const trak = box(
    'trak',
    Buffer.concat([timestamped('tkhd', creation), box('mdia', timestamped('mdhd', creation))]),
  );
  const moov = box('moov', Buffer.concat([mvhd(creation), udta, meta, trak]));
  return Buffer.concat([ftyp, mdat, moov]);
}

describe('scrubMediaFile — ISO-BMFF', () => {
  it('destroys GPS and device metadata, and never changes the file length', async () => {
    const original = mp4WithGps();
    const p = write('gps.mp4', original);
    expect(fs.readFileSync(p).includes(Buffer.from(GPS))).toBe(true);

    await scrubMediaFile(p, 'video/mp4');
    const after = fs.readFileSync(p);

    // The coordinates are gone…
    expect(after.includes(Buffer.from(GPS))).toBe(false);
    expect(after.includes(Buffer.from('Apple'))).toBe(false);
    // …the udta box is now `free` padding…
    expect(after.includes(Buffer.from('udta'))).toBe(false);
    expect(after.includes(Buffer.from('free'))).toBe(true);
    // …and the length is IDENTICAL, which is what makes this safe: nothing shifts,
    // so stco/co64 chunk offsets into mdat stay valid and the file can't be
    // corrupted by an arithmetic slip.
    expect(after.length).toBe(original.length);
  });

  it('zeroes recording timestamps but leaves the structural fields alone', async () => {
    const p = write('times.mp4', mp4WithGps(0xe679e672));
    await scrubMediaFile(p, 'video/mp4');
    const after = fs.readFileSync(p);

    const at = after.indexOf(Buffer.from('mvhd')) + 4;
    expect(after.readUInt8(at)).toBe(0); // version untouched
    expect(after.readUInt32BE(at + 4)).toBe(0); // creation_time wiped
    expect(after.readUInt32BE(at + 8)).toBe(0); // modification_time wiped
    expect(after.readUInt32BE(at + 12)).toBe(1000); // timescale SURVIVES
    expect(after.readUInt32BE(at + 16)).toBe(5000); // duration SURVIVES
  });

  it('leaves the media payload (mdat) byte-for-byte intact', async () => {
    const original = mp4WithGps();
    const p = write('payload.mp4', original);
    await scrubMediaFile(p, 'video/mp4');
    const after = fs.readFileSync(p);

    const start = original.indexOf(Buffer.from('mdat')) + 4;
    expect(after.subarray(start).equals(original.subarray(start))).toBe(true);
  });

  it('strips what a Samsung voice recorder writes into a 3GPP container', async () => {
    // The case that made us accept 3GPP at all (see contentClass.ts). The scrubber is
    // blind to the MIME past the mp3 branch, so this is really asking one question:
    // does the box walker reach metadata that sits AFTER a large mdat, in a container
    // whose only difference from mp4 is four bytes of `ftyp` brand?
    const original = samsungVoiceMemo();
    const p = write('samsung.3gp', original);
    for (const s of SAMSUNG_METADATA) {
      expect(original.includes(Buffer.from(s))).toBe(true);
    }

    await scrubMediaFile(p, 'video/3gpp');
    const after = fs.readFileSync(p);

    // The app fingerprint, the Android version, and the timezone are all gone.
    for (const s of SAMSUNG_METADATA) {
      expect(after.includes(Buffer.from(s))).toBe(false);
    }
    expect(after.includes(Buffer.from('udta'))).toBe(false);
    expect(after.includes(Buffer.from('meta'))).toBe(false);
    expect(after.includes(Buffer.from('free'))).toBe(true);

    // Size preserved, `ftyp` untouched (it still IS a 3gp4 file), audio byte-identical.
    expect(after.length).toBe(original.length);
    expect(after.subarray(0, 24).equals(original.subarray(0, 24))).toBe(true);
    const mdatFrom = original.indexOf(Buffer.from('mdat')) + 4;
    const mdatTo = mdatFrom + SAMSUNG_MDAT_BYTES;
    expect(after.subarray(mdatFrom, mdatTo).equals(original.subarray(mdatFrom, mdatTo))).toBe(true);
  });

  it('zeroes recording timestamps in tkhd and mdhd, not just mvhd', async () => {
    // NEUTRALIZE gets all the attention, but TIMESTAMPED covers three box types and
    // only mvhd was ever asserted. A real recording carries the same wall-clock in all
    // three, so missing one would leave "when was this recorded" fully recoverable.
    const original = samsungVoiceMemo(0xe6972a18);
    const p = write('samsung-times.3gp', original);
    await scrubMediaFile(p, 'video/3gpp');
    const after = fs.readFileSync(p);

    for (const type of ['mvhd', 'tkhd', 'mdhd']) {
      const at = after.indexOf(Buffer.from(type)) + 4;
      expect({ type, was: original.readUInt32BE(at + 4) }).toEqual({
        type,
        was: 0xe6972a18, // it really did carry one…
      });
      expect({ type, creation: after.readUInt32BE(at + 4) }).toEqual({ type, creation: 0 });
      expect({ type, modification: after.readUInt32BE(at + 8) }).toEqual({
        type,
        modification: 0,
      });
    }
    // …and the structural field right after them is untouched in tkhd/mdhd.
    for (const type of ['tkhd', 'mdhd']) {
      const at = after.indexOf(Buffer.from(type)) + 4;
      expect({ type, kept: after.readUInt32BE(at + 12) }).toEqual({ type, kept: 0x5eed });
    }
  });

  it('walks a REAL file written by a real muxer (macOS `say` → m4a)', async () => {
    // A synthesized fixture only proves the walker handles boxes I wrote myself.
    // `say` produces a genuine ISO-BMFF file (AAC in an MP4 container, ftyp M4A ),
    // which is the same container an iPhone voice memo lands in — and those can
    // carry location.
    const p = path.join(dir, 'real.m4a');
    try {
      execFileSync('say', ['-o', p, 'lurker media scrub test'], { stdio: 'ignore' });
    } catch {
      return; // not on macOS — the synthesized fixtures still cover the logic
    }
    const before = fs.readFileSync(p);
    expect(before.subarray(4, 8).toString()).toBe('ftyp');

    await scrubMediaFile(p, 'audio/x-m4a');
    const after = fs.readFileSync(p);

    expect(after.length).toBe(before.length);
    expect(after.subarray(0, 8).equals(before.subarray(0, 8))).toBe(true); // ftyp intact
    // The mvhd timestamps a real muxer wrote are now zero.
    const at = after.indexOf(Buffer.from('mvhd')) + 4;
    expect(before.readUInt32BE(at + 4)).toBeGreaterThan(0); // it really did carry one
    expect(after.readUInt32BE(at + 4)).toBe(0);
    // And it's still a playable-looking file: the audio payload is untouched.
    const mdatAt = before.indexOf(Buffer.from('mdat'));
    expect(after.subarray(mdatAt).equals(before.subarray(mdatAt))).toBe(true);

    // The assertions above only prove the BYTES changed the way we intended. They
    // cannot prove the file still parses. Hand it to an independent implementation —
    // macOS CoreAudio — and make it tell us: same track, same format, same duration.
    // Without this, a scrubber that quietly corrupts every video would pass its own
    // test suite.
    const info = execFileSync('afinfo', [p], { encoding: 'utf8' });
    expect(info).toMatch(/Num Tracks:\s*1/);
    expect(info).toMatch(/estimated duration:\s*[1-9]/); // non-zero, i.e. decodable
  });

  it('refuses a malformed container rather than passing the metadata through', async () => {
    // A box claiming to be bigger than the file. The image scrubbers fall back to
    // the original bytes when they get confused; here that would mean shipping
    // someone's GPS, so we refuse instead.
    const bad = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('moov')]);
    await expect(scrubMediaFile(write('bad.mp4', bad), 'video/mp4')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });
});

describe('scrubMediaFile — MP3', () => {
  function mp3(withId3v2: boolean, withId3v1: boolean): Buffer {
    const frames = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(512, 0x55)]);
    const parts: Buffer[] = [];
    if (withId3v2) {
      const body = Buffer.alloc(200);
      Buffer.from('TPE1').copy(body, 0);
      Buffer.from('Secret Artist Name').copy(body, 10);
      const size = Buffer.from([0x00, 0x00, 0x01, 0x48]); // synchsafe 200
      parts.push(Buffer.concat([Buffer.from('ID3'), Buffer.from([0x03, 0x00, 0x00]), size, body]));
    }
    parts.push(frames);
    if (withId3v1) {
      const v1 = Buffer.alloc(128);
      Buffer.from('TAG').copy(v1, 0);
      Buffer.from('Private Title').copy(v1, 3);
      parts.push(v1);
    }
    return Buffer.concat(parts);
  }

  it('blanks ID3v2 frames and ID3v1 fields, keeping the file length', async () => {
    const original = mp3(true, true);
    const p = write('tagged.mp3', original);
    await scrubMediaFile(p, 'audio/mpeg');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from('Secret Artist Name'))).toBe(false);
    expect(after.includes(Buffer.from('Private Title'))).toBe(false);
    // The tag headers survive, so both tags stay well-formed (an ID3v2 body of
    // zeros is legal padding; a `TAG` with blank fields is an empty ID3v1) — and
    // every byte offset in the file is unchanged.
    expect(after.subarray(0, 3).toString()).toBe('ID3');
    expect(after.subarray(after.length - 128, after.length - 125).toString()).toBe('TAG');
    expect(after.length).toBe(original.length);
    // The audio frames themselves are untouched.
    expect(after.readUInt16BE(210) === original.readUInt16BE(210)).toBe(true);
  });

  it('is a no-op on an untagged mp3', async () => {
    const original = mp3(false, false);
    const p = write('plain.mp3', original);
    await scrubMediaFile(p, 'audio/mpeg');
    expect(fs.readFileSync(p).equals(original)).toBe(true);
  });
});

describe('scrubMediaFile — pathological nesting', () => {
  function box(type: string, payload: Buffer): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + payload.length);
    return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
  }

  // Copilot's find: the depth guard used to `return` silently, so a udta hidden
  // below it survived un-scrubbed — neither scrubbed nor refused, which is the one
  // outcome this module promises never to produce. (Not an exploit: nesting moov in
  // moov hides only the uploader's OWN metadata from us.)
  it('refuses a file that nests metadata below the depth guard, rather than passing it through', async () => {
    let inner = box('udta', Buffer.from('+37.7749-122.4194/'));
    for (let i = 0; i < 10; i++) inner = box('moov', inner); // absurd nesting
    const ftyp = box(
      'ftyp',
      Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
    );
    const p = write('nested.mp4', Buffer.concat([ftyp, inner]));

    await expect(scrubMediaFile(p, 'video/mp4')).rejects.toBeInstanceOf(MediaScrubError);
    // And it stays untouched on disk, so nothing half-scrubbed can be dispatched:
    // the route turns the throw into a 415 and the temp file is discarded.
    expect(fs.readFileSync(p).includes(Buffer.from('+37.7749'))).toBe(true);
  });

  it('still handles the deepest nesting a real muxer produces (moov → trak → mdia)', async () => {
    const mdia = box('mdia', box('udta', Buffer.from('device: iPhone')));
    const trak = box('trak', Buffer.concat([mdia, box('udta', Buffer.from('+37.7749/'))]));
    const moov = box('moov', trak);
    const ftyp = box(
      'ftyp',
      Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
    );
    const p = write('deep-ok.mp4', Buffer.concat([ftyp, moov]));

    await scrubMediaFile(p, 'video/mp4');
    const after = fs.readFileSync(p);
    expect(after.includes(Buffer.from('+37.7749'))).toBe(false);
    expect(after.includes(Buffer.from('iPhone'))).toBe(false); // nested one level deeper
  });
});
