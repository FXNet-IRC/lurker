// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { shouldOpenSystemBufferOnLoad } from './defaultBuffer.js';

describe('shouldOpenSystemBufferOnLoad', () => {
  it('opens the system buffer on a plain cold load', () => {
    expect(shouldOpenSystemBufferOnLoad(null, undefined)).toBe(true);
  });

  it('stands aside for a deep link that has not resolved yet', () => {
    // THE regression. A cold load at /buffer/7 can't resolve that id until the
    // socket and buffer list arrive, so activeKey is null at mount — exactly the
    // condition the old `activeKey == null` check took as "nothing claimed a
    // buffer". Falling back here ends with the system buffer's row id
    // overwriting the URL, and every bookmark, refresh and copied message link
    // landing on the system console.
    expect(shouldOpenSystemBufferOnLoad(null, '7')).toBe(false);
  });

  it('stands aside once anything is already active', () => {
    expect(shouldOpenSystemBufferOnLoad('1::#chan', undefined)).toBe(false);
    expect(shouldOpenSystemBufferOnLoad(':system:', undefined)).toBe(false);
  });
});
