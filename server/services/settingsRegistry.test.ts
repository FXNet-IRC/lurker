// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { validate, REGISTRY, getOption, defaultsAsObject } from './settingsRegistry.js';

// Pick representative keys from the live registry so the tests track real
// schema, not hand-picked fixtures.
const BOOL_KEY = REGISTRY.find((o) => o.type === 'bool')!.key;
const INT_KEY = REGISTRY.find((o) => o.type === 'int')!.key;
const STRING_KEY = REGISTRY.find((o) => o.type === 'string')!.key;
const ENUM_KEY = REGISTRY.find((o) => o.type === 'enum')!.key;
const STRING_LIST_KEY = REGISTRY.find((o) => o.type === 'string-list')!.key;
const COLOR_KEY = REGISTRY.find((o) => o.type === 'color')!.key;

describe('validate', () => {
  it('rejects unknown keys', () => {
    expect(validate('no.such.key', 1).ok).toBe(false);
  });

  describe('bool', () => {
    it('accepts true/false only', () => {
      expect(validate(BOOL_KEY, true).ok).toBe(true);
      expect(validate(BOOL_KEY, false).ok).toBe(true);
      expect(validate(BOOL_KEY, 'true').ok).toBe(false);
      expect(validate(BOOL_KEY, 1).ok).toBe(false);
    });
  });

  describe('int', () => {
    const opt = getOption(INT_KEY);
    it('rejects non-integers', () => {
      expect(validate(INT_KEY, 'not-a-number').ok).toBe(false);
      expect(validate(INT_KEY, 3.14).ok).toBe(false);
    });
    it('coerces numeric strings', () => {
      const out = validate(INT_KEY, String(opt!.default));
      expect(out.ok).toBe(true);
      expect(out.ok && out.value).toBe(opt!.default);
    });
    it('rejects values below the min', () => {
      // The first int registry entry (look.font.size) always has min=9. Use the
      // live registry value so this stays accurate if the default ever changes.
      const intOpt = opt as unknown as { key: string; min: number; max: number };
      expect(validate(intOpt.key, intOpt.min - 1).ok).toBe(false);
    });
    it('rejects values above the max', () => {
      const intOpt = opt as unknown as { key: string; min: number; max: number };
      expect(validate(intOpt.key, intOpt.max + 1).ok).toBe(false);
    });
  });

  describe('int minNonzero', () => {
    // Retention is the live carrier of the field: 0 = unlimited is valid, a
    // small live cap is a guarded footgun (pruning is irreversible).
    const KEY = 'data.retention.lines';
    it('the registry actually carries the field under test', () => {
      const opt = getOption(KEY);
      expect(opt?.type === 'int' ? opt.minNonzero : undefined).toBe(1000);
    });
    it('accepts 0 (off) and the floor itself', () => {
      expect(validate(KEY, 0).ok).toBe(true);
      expect(validate(KEY, 1000).ok).toBe(true);
    });
    it('rejects the hole between 0 and the floor', () => {
      const out = validate(KEY, 50);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toMatch(/0 or >= 1000/);
    });
    it('the hours knob carries its own floor (24) — it acts even faster', () => {
      expect(validate('data.retention.event_hours', 23).ok).toBe(false);
      expect(validate('data.retention.event_hours', 24).ok).toBe(true);
      expect(validate('data.retention.event_hours', 0).ok).toBe(true);
    });
    it('closed-buffer GC floors at a week — it deletes whole buffers', () => {
      expect(validate('data.retention.closed_buffer_days', 6).ok).toBe(false);
      expect(validate('data.retention.closed_buffer_days', 7).ok).toBe(true);
      expect(validate('data.retention.closed_buffer_days', 0).ok).toBe(true);
    });
  });

  describe('string / color', () => {
    it('accepts strings', () => {
      expect(validate(STRING_KEY, 'anything').ok).toBe(true);
      expect(validate(COLOR_KEY, '#ff0000').ok).toBe(true);
    });
    it('rejects non-strings', () => {
      expect(validate(STRING_KEY, 42).ok).toBe(false);
    });
  });

  describe('enum', () => {
    const opt = getOption(ENUM_KEY);
    it('accepts a listed choice', () => {
      const choice = opt && opt.type === 'enum' ? opt.choices[0] : '';
      expect(validate(ENUM_KEY, choice).ok).toBe(true);
    });
    it('rejects a non-listed string', () => {
      expect(validate(ENUM_KEY, 'definitely-not-listed').ok).toBe(false);
    });
    it('rejects non-strings', () => {
      expect(validate(ENUM_KEY, 42).ok).toBe(false);
    });
  });

  describe('string-list', () => {
    it('accepts an array of strings', () => {
      expect(validate(STRING_LIST_KEY, ['a', 'b']).ok).toBe(true);
      expect(validate(STRING_LIST_KEY, []).ok).toBe(true);
    });
    it('rejects non-arrays and arrays with non-string entries', () => {
      expect(validate(STRING_LIST_KEY, 'not-an-array').ok).toBe(false);
      expect(validate(STRING_LIST_KEY, ['a', 42]).ok).toBe(false);
    });
  });
});

describe('defaultsAsObject', () => {
  it('returns every registry key with its default value', () => {
    const defaults = defaultsAsObject();
    for (const opt of REGISTRY) {
      expect(defaults[opt.key]).toEqual(opt.default);
    }
  });
});
