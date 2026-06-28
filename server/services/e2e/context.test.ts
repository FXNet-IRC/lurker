// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { contextKey } from './context.js';

describe('contextKey', () => {
  it('passes channel targets through unchanged', () => {
    expect(contextKey('#rust', '~bob@b.host')).toBe('#rust');
    expect(contextKey('&local', '~bob@b.host')).toBe('&local');
    expect(contextKey('!HXYZ', '~bob@b.host')).toBe('!HXYZ');
    expect(contextKey('+modeless', '~bob@b.host')).toBe('+modeless');
  });

  it('maps a PM target to the @ident@host pseudochannel', () => {
    expect(contextKey('bob', '~bob@home.example.org')).toBe('@~bob@home.example.org');
  });

  it('distinguishes the same nick from different hosts', () => {
    expect(contextKey('bob', '~bob@home.example.org')).not.toBe(
      contextKey('bob', '~bob@vpn.example.org'),
    );
  });
});
