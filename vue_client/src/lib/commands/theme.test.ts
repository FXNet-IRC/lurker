// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseThemeCommand } from './theme.js';

describe('parseThemeCommand', () => {
  it('treats no args as list', () => {
    expect(parseThemeCommand('')).toEqual({ kind: 'list' });
    expect(parseThemeCommand('   ')).toEqual({ kind: 'list' });
  });

  it('parses explicit list (and ls alias)', () => {
    expect(parseThemeCommand('list')).toEqual({ kind: 'list' });
    expect(parseThemeCommand('ls')).toEqual({ kind: 'list' });
  });

  it('parses apply with the rest of the line as the name', () => {
    expect(parseThemeCommand('apply Light')).toEqual({ kind: 'apply', name: 'Light' });
    expect(parseThemeCommand('apply My Ocean Theme')).toEqual({
      kind: 'apply',
      name: 'My Ocean Theme',
    });
  });

  it('accepts apply aliases', () => {
    expect(parseThemeCommand('switch Dark')).toEqual({ kind: 'apply', name: 'Dark' });
    expect(parseThemeCommand('load Dark')).toEqual({ kind: 'apply', name: 'Dark' });
  });

  it('strips one layer of surrounding quotes from names', () => {
    expect(parseThemeCommand('save "My Theme"')).toEqual({ kind: 'save', name: 'My Theme' });
    expect(parseThemeCommand("delete 'Old One'")).toEqual({ kind: 'delete', name: 'Old One' });
  });

  it('parses save and delete (with aliases)', () => {
    expect(parseThemeCommand('save Ocean')).toEqual({ kind: 'save', name: 'Ocean' });
    expect(parseThemeCommand('delete Ocean')).toEqual({ kind: 'delete', name: 'Ocean' });
    expect(parseThemeCommand('del Ocean')).toEqual({ kind: 'delete', name: 'Ocean' });
    expect(parseThemeCommand('rm Ocean')).toEqual({ kind: 'delete', name: 'Ocean' });
    expect(parseThemeCommand('remove Ocean')).toEqual({ kind: 'delete', name: 'Ocean' });
  });

  it('is case-insensitive on the verb but preserves name case', () => {
    expect(parseThemeCommand('APPLY Ocean Deep')).toEqual({ kind: 'apply', name: 'Ocean Deep' });
  });

  it('errors when a name is missing', () => {
    expect(parseThemeCommand('apply')).toMatchObject({ kind: 'error' });
    expect(parseThemeCommand('save')).toMatchObject({ kind: 'error' });
    expect(parseThemeCommand('delete  ')).toMatchObject({ kind: 'error' });
  });

  it('parses mode: bare shows, single/system set, anything else errors', () => {
    expect(parseThemeCommand('mode')).toEqual({ kind: 'mode', mode: null });
    expect(parseThemeCommand('mode single')).toEqual({ kind: 'mode', mode: 'single' });
    expect(parseThemeCommand('mode SYSTEM')).toEqual({ kind: 'mode', mode: 'system' });
    expect(parseThemeCommand('mode auto')).toMatchObject({ kind: 'error' });
  });

  it('parses use with a slot and a rest-of-line name', () => {
    expect(parseThemeCommand('use light My Light')).toEqual({
      kind: 'use',
      slot: 'light',
      name: 'My Light',
    });
    expect(parseThemeCommand('use DARK Dark')).toEqual({ kind: 'use', slot: 'dark', name: 'Dark' });
  });

  it('errors on use without a valid slot or name', () => {
    expect(parseThemeCommand('use')).toMatchObject({ kind: 'error' });
    expect(parseThemeCommand('use sideways Ocean')).toMatchObject({ kind: 'error' });
    expect(parseThemeCommand('use light')).toMatchObject({ kind: 'error' });
  });

  it('errors on an unknown subcommand', () => {
    expect(parseThemeCommand('frobnicate').kind).toBe('error');
  });
});
