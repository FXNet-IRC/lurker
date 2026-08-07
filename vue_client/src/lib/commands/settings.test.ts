// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { splitSetArgs, coerceSettingValue, formatSettingValue } from './settings.js';
import type { SettingOption } from '../../../../shared/settingsRegistry.js';

// Minimal registry options for each type — keeps the coercion/format tests
// independent of the real registry's contents.
const base = { label: 'x', category: 'c', group: 'g', description: 'd' };
const boolOpt = { ...base, key: 'a.bool', type: 'bool', default: false } satisfies SettingOption;
const intOpt = {
  ...base,
  key: 'a.int',
  type: 'int',
  min: 9,
  max: 32,
  default: 14,
} satisfies SettingOption;
const enumOpt = {
  ...base,
  key: 'a.enum',
  type: 'enum',
  choices: ['left', 'right'],
  default: 'left',
} satisfies SettingOption;
const listOpt = {
  ...base,
  key: 'a.list',
  type: 'string-list',
  default: [],
} satisfies SettingOption;
const strOpt = { ...base, key: 'a.str', type: 'string', default: '' } satisfies SettingOption;
const secretOpt = { ...base, key: 'a.secret', type: 'secret', default: '' } satisfies SettingOption;

describe('splitSetArgs', () => {
  it('treats empty and `?` as a list request', () => {
    expect(splitSetArgs('')).toEqual({ kind: 'list' });
    expect(splitSetArgs('   ')).toEqual({ kind: 'list' });
    expect(splitSetArgs('?')).toEqual({ kind: 'list' });
  });

  it('returns keyonly when no value follows the key', () => {
    expect(splitSetArgs('look.font.size')).toEqual({ kind: 'keyonly', key: 'look.font.size' });
  });

  it('takes the rest of the line as the value (no quoting needed)', () => {
    expect(splitSetArgs('look.font.family Input Mono, ui-monospace')).toEqual({
      kind: 'pair',
      key: 'look.font.family',
      rawValue: 'Input Mono, ui-monospace',
    });
  });

  it('strips one layer of surrounding quotes', () => {
    expect(splitSetArgs('k "a b c"')).toEqual({ kind: 'pair', key: 'k', rawValue: 'a b c' });
    expect(splitSetArgs("k 'a b'")).toEqual({ kind: 'pair', key: 'k', rawValue: 'a b' });
    // one-sided quote left intact
    expect(splitSetArgs('k "a b')).toEqual({ kind: 'pair', key: 'k', rawValue: '"a b' });
  });
});

describe('coerceSettingValue', () => {
  it('coerces booleans from many spellings', () => {
    for (const t of ['true', 'on', 'YES', '1']) {
      expect(coerceSettingValue(boolOpt, t)).toEqual({ ok: true, value: true });
    }
    for (const f of ['false', 'off', 'No', '0']) {
      expect(coerceSettingValue(boolOpt, f)).toEqual({ ok: true, value: false });
    }
    expect(coerceSettingValue(boolOpt, 'maybe')).toMatchObject({ ok: false });
  });

  it('coerces and range-checks integers', () => {
    expect(coerceSettingValue(intOpt, '16')).toEqual({ ok: true, value: 16 });
    expect(coerceSettingValue(intOpt, '8')).toMatchObject({ ok: false });
    expect(coerceSettingValue(intOpt, '40')).toMatchObject({ ok: false });
    expect(coerceSettingValue(intOpt, '1.5')).toMatchObject({ ok: false });
    expect(coerceSettingValue(intOpt, 'abc')).toMatchObject({ ok: false });
  });

  it('validates enums against their choices', () => {
    expect(coerceSettingValue(enumOpt, 'right')).toEqual({ ok: true, value: 'right' });
    expect(coerceSettingValue(enumOpt, 'up')).toEqual({
      ok: false,
      error: 'a.enum must be one of: left, right',
    });
  });

  it('splits string-lists on commas and trims, dropping empties', () => {
    expect(coerceSettingValue(listOpt, 'a, b ,c,')).toEqual({ ok: true, value: ['a', 'b', 'c'] });
    expect(coerceSettingValue(listOpt, '   ')).toEqual({ ok: true, value: [] });
  });

  it('passes strings, colors, and secrets through verbatim', () => {
    expect(coerceSettingValue(strOpt, "'Input Mono', monospace")).toEqual({
      ok: true,
      value: "'Input Mono', monospace",
    });
    expect(coerceSettingValue(secretOpt, 'sk-123')).toEqual({ ok: true, value: 'sk-123' });
  });
});

describe('formatSettingValue', () => {
  it('masks secrets rather than revealing them', () => {
    expect(formatSettingValue(secretOpt, 'sk-123')).toBe('(set)');
    expect(formatSettingValue(secretOpt, '')).toBe('(unset)');
  });

  it('renders booleans, lists, and empties readably', () => {
    expect(formatSettingValue(boolOpt, true)).toBe('true');
    expect(formatSettingValue(listOpt, ['a', 'b'])).toBe('a, b');
    expect(formatSettingValue(listOpt, [])).toBe('(empty)');
    expect(formatSettingValue(strOpt, '')).toBe('(empty)');
    expect(formatSettingValue(intOpt, 14)).toBe('14');
  });

  // A labelled enum reads as its id with the label in parens — the REVERSE of the
  // Settings pane, on purpose. The id is what you type back to `/set`, so it has
  // to stay the value; the label is only there to connect this line to what the
  // GUI calls the same setting.
  it('shows a labelled enum as id (Label), keeping the id typeable', () => {
    const labelled = {
      ...enumOpt,
      key: 'a.labelled',
      choices: ['all', 'none'],
      choiceLabels: { all: 'No filter', none: 'Hide all' },
    } satisfies SettingOption;
    expect(formatSettingValue(labelled, 'all')).toBe('all (No filter)');
    expect(formatSettingValue(labelled, 'none')).toBe('none (Hide all)');
  });

  it('leaves an unlabelled enum choice as the bare value', () => {
    // Both the no-choiceLabels case (every enum before this existed) and a
    // partial map, which the registry explicitly allows.
    expect(formatSettingValue(enumOpt, 'left')).toBe('left');
    const partial = {
      ...enumOpt,
      key: 'a.partial',
      choiceLabels: { left: 'Left' },
    } satisfies SettingOption;
    expect(formatSettingValue(partial, 'right')).toBe('right');
  });
});
