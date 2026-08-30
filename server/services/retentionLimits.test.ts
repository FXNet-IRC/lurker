// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The clamp matrix for effectiveRetentionLines: user setting × operator
// ceiling, with 0 meaning "unlimited" at both layers, and the fail-open
// handling of an unparseable ceiling (a typo must never mass-delete history).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let deleteUserSetting: typeof import('../db/settings.js').deleteUserSetting;
let effectiveRetentionLines: typeof import('./retentionLimits.js').effectiveRetentionLines;
let declaredRetentionCeilingLines: typeof import('./retentionLimits.js').declaredRetentionCeilingLines;
let effectiveEventRetentionHours: typeof import('./retentionLimits.js').effectiveEventRetentionHours;
let declaredEventRetentionCeilingHours: typeof import('./retentionLimits.js').declaredEventRetentionCeilingHours;
let effectiveClosedBufferDays: typeof import('./retentionLimits.js').effectiveClosedBufferDays;

let userId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ setUserSetting, deleteUserSetting } = await import('../db/settings.js'));
  ({
    effectiveRetentionLines,
    declaredRetentionCeilingLines,
    effectiveEventRetentionHours,
    declaredEventRetentionCeilingHours,
    effectiveClosedBufferDays,
  } = await import('./retentionLimits.js'));
  userId = createUser('retention-alice').id;
});

afterEach(() => {
  delete process.env.LURKER_MAX_RETENTION_LINES;
  delete process.env.LURKER_MAX_EVENT_RETENTION_HOURS;
  delete process.env.LURKER_MAX_CLOSED_BUFFER_DAYS;
  deleteUserSetting(userId, 'data.retention.lines');
  deleteUserSetting(userId, 'data.retention.event_hours');
  deleteUserSetting(userId, 'data.retention.closed_buffer_days');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('declaredRetentionCeilingLines', () => {
  it('unset means no ceiling', () => {
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('0 is an explicit no-ceiling spelling, not a misconfiguration', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '0';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('a bare integer is the ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '100000';
    expect(declaredRetentionCeilingLines()).toBe(100000);
  });

  it('garbage fails open to no ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '100k';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('a negative value fails open to no ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '-5';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });

  it('Number() coercions are NOT accepted — bare decimal integers only', () => {
    // "1.9" → 1 or "1e5" → 100000 would enable pruning with a ceiling the
    // operator never wrote; both must fail open instead.
    process.env.LURKER_MAX_RETENTION_LINES = '1.9';
    expect(declaredRetentionCeilingLines()).toBeNull();
    process.env.LURKER_MAX_RETENTION_LINES = '1e5';
    expect(declaredRetentionCeilingLines()).toBeNull();
  });
});

describe('effectiveRetentionLines', () => {
  it('nothing set anywhere = unlimited (0)', () => {
    expect(effectiveRetentionLines(userId)).toBe(0);
  });

  it('a user setting alone governs', () => {
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });

  it('the ceiling alone IS the default for an untouched user', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('a user above the ceiling is clamped down to it', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 20000);
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('a user below the ceiling keeps their own tighter cap', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });

  it('an explicit user 0 (unlimited) still clamps to the ceiling', () => {
    process.env.LURKER_MAX_RETENTION_LINES = '10000';
    setUserSetting(userId, 'data.retention.lines', 0);
    expect(effectiveRetentionLines(userId)).toBe(10000);
  });

  it('an unparseable ceiling leaves the user cap governing', () => {
    process.env.LURKER_MAX_RETENTION_LINES = 'lots';
    setUserSetting(userId, 'data.retention.lines', 5000);
    expect(effectiveRetentionLines(userId)).toBe(5000);
  });

  it('the 1000-line floor is write-time only — a stored value enforces as stored', () => {
    // minNonzero lives in validate(), the sole surface a user can write
    // through. The resolver deliberately does NOT re-floor: no legacy rows
    // can predate the floor (it shipped with the feature), and keeping the
    // resolver literal lets tests inject tiny caps instead of looping
    // thousands of rows per case.
    setUserSetting(userId, 'data.retention.lines', 50);
    expect(effectiveRetentionLines(userId)).toBe(50);
  });
});

describe('effectiveEventRetentionHours', () => {
  it('an untouched user gets the registry default (168 — the clock is ON)', () => {
    expect(effectiveEventRetentionHours(userId)).toBe(168);
  });

  it('a user setting alone governs, and 0 turns the clock off', () => {
    setUserSetting(userId, 'data.retention.event_hours', 72);
    expect(effectiveEventRetentionHours(userId)).toBe(72);
    setUserSetting(userId, 'data.retention.event_hours', 0);
    expect(effectiveEventRetentionHours(userId)).toBe(0);
  });

  it('the ceiling clamps: default stays under it, 0 becomes it, above it clamps', () => {
    process.env.LURKER_MAX_EVENT_RETENTION_HOURS = '336';
    expect(effectiveEventRetentionHours(userId)).toBe(168);
    setUserSetting(userId, 'data.retention.event_hours', 0);
    expect(effectiveEventRetentionHours(userId)).toBe(336);
    setUserSetting(userId, 'data.retention.event_hours', 500);
    expect(effectiveEventRetentionHours(userId)).toBe(336);
  });

  it('an absurdly large ceiling fails open instead of feeding date math', () => {
    // 9999999999 hours survives the digits regex but would make
    // new Date(now - hours*3600e3) throw RangeError in the sweeper — and the
    // circuit breaker would then stop ALL retention, line cap included.
    process.env.LURKER_MAX_EVENT_RETENTION_HOURS = '9999999999';
    expect(declaredEventRetentionCeilingHours()).toBeNull();
  });

  it('an oversized LINES ceiling clamps instead of vanishing', () => {
    // Different consequence, different behavior: lines have no date math, and
    // rejecting an oversized-but-working ceiling would silently UNBOUND an
    // instance that upgraded — clamp to the rail and keep enforcing.
    process.env.LURKER_MAX_RETENTION_LINES = '2000000000';
    expect(declaredRetentionCeilingLines()).toBe(1_000_000_000);
  });
});

describe('effectiveClosedBufferDays', () => {
  it('defaults to 0 — closed buffers are kept unless the user opts in', () => {
    expect(effectiveClosedBufferDays(userId)).toBe(0);
  });

  it('the operator ceiling carries the same 7-day floor as the user knob', () => {
    // A 1-day ceiling would force-delete EVERY account's closed buffers after
    // 24h — the one path that overrides everyone must not skip the footgun rail.
    process.env.LURKER_MAX_CLOSED_BUFFER_DAYS = '1';
    expect(effectiveClosedBufferDays(userId)).toBe(0);
  });

  it('a user setting governs; an operator ceiling forces collection for a 0 user', () => {
    setUserSetting(userId, 'data.retention.closed_buffer_days', 30);
    expect(effectiveClosedBufferDays(userId)).toBe(30);
    process.env.LURKER_MAX_CLOSED_BUFFER_DAYS = '14';
    expect(effectiveClosedBufferDays(userId)).toBe(14);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 0);
    expect(effectiveClosedBufferDays(userId)).toBe(14);
  });
});
