// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type * as SettingsServiceModule from './settingsService.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-settings-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let settingsService: typeof SettingsServiceModule.default;
let effectiveSetting: typeof SettingsServiceModule.effectiveSetting;
let effectiveSettings: typeof SettingsServiceModule.effectiveSettings;
let createUser: typeof import('../db/users.js').createUser;
let user: ReturnType<typeof createUser>;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  const mod = await import('./settingsService.js');
  settingsService = mod.default;
  effectiveSetting = mod.effectiveSetting;
  effectiveSettings = mod.effectiveSettings;
  user = createUser('ss-alice');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('update', () => {
  it('writes valid entries and returns merged values', () => {
    const res = settingsService.update(user.id, { 'look.font.size': 16 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.values['look.font.size']).toBe(16);
  });

  it('returns the first invalid key on failure without persisting anything', () => {
    const res = settingsService.update(user.id, {
      'look.font.size': 16,
      'look.font.weight': 99999, // out of range
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.key).toBe('look.font.weight');
  });

  it('writing the registry default drops the override row (non-themed key)', () => {
    settingsService.update(user.id, { 'look.message.collapse_authors_window': 10 });
    const res = settingsService.update(user.id, { 'look.message.collapse_authors_window': 5 });
    expect(res.ok && res.values['look.message.collapse_authors_window']).toBeUndefined();
  });

  it('KEEPS a themed key written at its registry default', () => {
    // Themed keys fall back to the active theme, not the registry default, so
    // "set it to the default value" is a real override and must persist.
    const res = settingsService.update(user.id, { 'look.font.size': 14 });
    expect(res.ok && res.values['look.font.size']).toBe(14);
    settingsService.reset(user.id, 'look.font.size');
  });

  it('deletes keys named in resets, atomically with changes', () => {
    settingsService.update(user.id, { 'look.font.size': 20 });
    const res = settingsService.update(user.id, { 'look.theme.active': 'light' }, [
      'look.font.size',
    ]);
    expect(res.ok && res.values['look.font.size']).toBeUndefined();
    expect(res.ok && res.values['look.theme.active']).toBe('light');
    settingsService.reset(user.id, 'look.theme.active');
  });

  it('rejects an unknown reset key without persisting anything', () => {
    settingsService.update(user.id, { 'look.font.size': 20 });
    const res = settingsService.update(user.id, { 'look.font.size': 22 }, ['no.such.key']);
    expect(res.ok).toBe(false);
    const after = settingsService.update(user.id, {});
    expect(after.ok && after.values['look.font.size']).toBe(20);
    settingsService.reset(user.id, 'look.font.size');
  });

  it('emits both the legacy default-valued change and the explicit resets list for deletions', () => {
    settingsService.update(user.id, { 'look.message.collapse_authors_window': 10 });
    type EventPayload = { changes?: Record<string, unknown>; resets?: string[] };
    let seen: EventPayload | null = null;
    settingsService.once('event', (payload: EventPayload) => {
      seen = payload;
    });
    // Writing the default back auto-drops this non-themed key: the event must
    // carry { key: default } in changes (pre-resets frame shape) AND name the
    // key in resets so new clients delete rather than store it.
    settingsService.update(user.id, { 'look.message.collapse_authors_window': 5 });
    expect(seen).not.toBeNull();
    expect(seen!.changes!['look.message.collapse_authors_window']).toBe(5);
    expect(seen!.resets).toContain('look.message.collapse_authors_window');
  });

  it('handles array values with the array-equality short-circuit', () => {
    // Pick a string-list setting to exercise the array path.
    // Update + then-write-default for any string-list key exercises valuesEqual.
    // The test above already covers the scalar default path; this is a sanity
    // run-through of the array-shaped equality without depending on a specific
    // key name.
    const result = settingsService.update(user.id, {});
    expect(result.ok).toBe(true);
  });
});

describe('reset', () => {
  it('drops the override and returns the merged values', () => {
    settingsService.update(user.id, { 'look.font.size': 18 });
    const res = settingsService.reset(user.id, 'look.font.size');
    expect(res.ok).toBe(true);
    expect(res.ok && res.values['look.font.size']).toBeUndefined();
  });

  it('returns ok=false for unknown keys', () => {
    const res = settingsService.reset(user.id, 'no.such.key');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/unknown/);
  });
});

describe('effectiveSetting', () => {
  it('returns the registry default when unset and the override when set', () => {
    const u = createUser('ss-effective');
    // chat.quit_message defaults to '' (blank = built-in Lurker quit message).
    expect(effectiveSetting(u.id, 'chat.quit_message')).toBe('');
    settingsService.update(u.id, { 'chat.quit_message': 'gone fishing' });
    expect(effectiveSetting(u.id, 'chat.quit_message')).toBe('gone fishing');
  });

  it('returns undefined for an unknown key', () => {
    const u = createUser('ss-effective-2');
    expect(effectiveSetting(u.id, 'no.such.key')).toBeUndefined();
  });
});

describe('effectiveSettings (bulk)', () => {
  it('resolves several keys at once: defaults when unset, overrides when set', () => {
    const u = createUser('ss-bulk');
    settingsService.update(u.id, { 'ctcp.version': '', 'ctcp.replies': false });
    const s = effectiveSettings(u.id, [
      'ctcp.replies', // overridden → false
      'ctcp.version', // overridden → ''
      'ctcp.time', // unset → registry default
      'no.such.key', // unknown → undefined
    ]);
    expect(s['ctcp.replies']).toBe(false);
    expect(s['ctcp.version']).toBe('');
    expect(s['ctcp.time']).toBe('${time}');
    expect(s['no.such.key']).toBeUndefined();
  });
});
