// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

setupTestDb('services-upload-limits');

const MIB = 1024 * 1024;
const ENVELOPE = 64 * 1024;

let user: User;
let fresh: User;
let setUserSetting: (userId: number, key: string, value: unknown) => void;
let limits: typeof import('./uploadLimits.js');

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ setUserSetting } = await import('../db/settings.js'));
  limits = await import('./uploadLimits.js');
  user = createUser('alice');
  fresh = createUser('root');
});

afterEach(() => {
  delete process.env.LURKER_MAX_UPLOAD_MB;
  vi.restoreAllMocks();
});

describe('transportCapBytes', () => {
  it('is the hard ceiling when unset — a self-hoster with nothing in front of them', () => {
    expect(limits.transportCapBytes()).toBe(limits.MAX_CAP_BYTES);
  });

  // The bug this feature exists to kill: a proxy limit applies to the whole
  // request body, so advertising it as a FILE size sends the client back with a
  // body just over the line. The envelope has to come off the top.
  it('reserves multipart headroom, so a file at the cap still fits in the body', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    const cap = limits.transportCapBytes();
    expect(cap).toBe(100 * 1_000_000 - ENVELOPE);
    expect(cap).toBeLessThan(100 * 1_000_000);
  });

  // Cloudflare documents decimal MB; nginx's client_max_body_size 100m is MiB.
  // Decimal is the smaller reading, so it's the safe one when the proxy is unknown.
  it('reads the declared MB as decimal, never as the larger MiB', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.transportCapBytes()).toBeLessThan(100 * MIB);
  });

  it('can never RAISE the hard ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '5000';
    expect(limits.transportCapBytes()).toBe(limits.MAX_CAP_BYTES);
  });

  // Silently ignoring "100MB" — the natural typo, given the var is named _MB —
  // leaves the operator staring at a setting that never took while uploads keep
  // dying at the edge. The fallback is right; the silence isn't.
  //
  // FIRST in this describe on purpose: the warning is latched once per process,
  // so any earlier test that trips an unparseable value consumes it.
  it('warns about an unparseable value instead of ignoring it silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.LURKER_MAX_UPLOAD_MB = '100MB';
    expect(limits.transportCapBytes()).toBe(limits.MAX_CAP_BYTES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LURKER_MAX_UPLOAD_MB'));
    // Once per process, not once per upload — this runs on every snapshot.
    limits.transportCapBytes();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats garbage and non-positive values as unset, never as "refuse everything"', () => {
    // A typo would otherwise take every upload on the instance down, which is a
    // much worse failure than ignoring the value.
    for (const raw of ['', '  ', 'lots', '0', '-10', 'NaN']) {
      process.env.LURKER_MAX_UPLOAD_MB = raw;
      expect(limits.transportCapBytes()).toBe(limits.MAX_CAP_BYTES);
    }
  });

  it('floors a fractional value rather than rounding up past the proxy limit', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '99.9';
    expect(limits.transportCapBytes()).toBe(99 * 1_000_000 - ENVELOPE);
  });
});

describe('effectiveUploadCapBytes', () => {
  it("defaults to the user's own setting, in MiB", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(150 * MIB);
  });

  it('is the SMALLEST of the ceilings — the transport limit wins when it is lower', () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 150);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(100 * 1_000_000 - ENVELOPE);
  });

  it("does not inflate a user's lower cap up to the transport limit", () => {
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.effectiveUploadCapBytes(user.id, false)).toBe(25 * MIB);
  });

  it('answers for a user with no settings row at all (registry default applies)', () => {
    // "How big may I upload" must have an answer before the user has touched a
    // single setting — this is the value a fresh client is told on connect.
    const cap = limits.effectiveUploadCapBytes(fresh.id, true);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(limits.MAX_CAP_BYTES);
  });
});

// #649: a caller with its own, larger limit (imports allow 500 MB) needs the raw
// declaration. transportCapBytes() reports "unset" as the upload path's 200 MB
// hard cap, so reusing it would have silently cost imports 300 MB of headroom.
describe('clampToTransport', () => {
  const IMPORT_LIMIT = 500 * 1024 * 1024;

  it('leaves a larger own-limit ALONE when no ceiling is declared', () => {
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBe(IMPORT_LIMIT);
    expect(limits.transportCapBytes()).toBe(limits.MAX_CAP_BYTES); // the trap
  });

  it('lowers it to the declared ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBe(100 * 1_000_000 - ENVELOPE);
  });

  it('never RAISES an own-limit that is already lower than the ceiling', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '400';
    expect(limits.clampToTransport(10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
  });

  it('is not bounded by the upload hard cap — that is an upload-path rule', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '400';
    expect(limits.clampToTransport(IMPORT_LIMIT)).toBeGreaterThan(limits.MAX_CAP_BYTES);
  });
});

describe('declaredTransportCapBytes', () => {
  it('is null when unset, distinguishing "no ceiling" from "200 MB"', () => {
    expect(limits.declaredTransportCapBytes()).toBeNull();
  });

  it('is null for a value that will not parse', () => {
    // Stub console.warn: this trips the warn-once path, and whether it actually
    // prints depends on whether an earlier test already latched it. Stubbing
    // makes the output the same either way, so reordering this file can't start
    // spraying warnings through an unrelated suite run.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.LURKER_MAX_UPLOAD_MB = '100m';
    expect(limits.declaredTransportCapBytes()).toBeNull();
  });
});

describe('clampUploadCapBytes', () => {
  it('never resolves to a zero or negative cap', () => {
    expect(limits.clampUploadCapBytes(0)).toBe(1);
    expect(limits.clampUploadCapBytes(-5)).toBe(1);
  });

  it('applies the transport ceiling to a policy cap the operator baked higher', () => {
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    expect(limits.clampUploadCapBytes(200 * MIB)).toBe(100 * 1_000_000 - ENVELOPE);
  });
});

describe('formatCapMb', () => {
  // A whole number would be a lie once the envelope headroom is subtracted:
  // "exceeds 5 MB" when the real limit is 4.7 sends the user back with another
  // file that fails exactly the same way.
  it('keeps a decimal when the cap is not a whole MB, and rounds DOWN', () => {
    expect(limits.formatCapMb(5 * 1_000_000 - ENVELOPE)).toBe('4.7');
    expect(limits.formatCapMb(25 * MIB)).toBe('25');
  });

  it('drops the decimal on larger caps, where it is noise', () => {
    expect(limits.formatCapMb(100 * 1_000_000 - ENVELOPE)).toBe('95');
  });
});
