// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { shouldRepinOnSend } from './sendScroll.js';

describe('shouldRepinOnSend', () => {
  it('re-pins by default', () => {
    expect(shouldRepinOnSend({ keepPosition: false, detached: false })).toBe(true);
  });

  it('stays put when the user asked to keep their position', () => {
    expect(shouldRepinOnSend({ keepPosition: true, detached: false })).toBe(false);
  });

  it('re-pins from a detached slice even with the setting on', () => {
    // The sent message isn't in the loaded slice, so staying would show the
    // user a stretch of history their line can never appear in. The caller
    // re-attaches alongside this; the scroll is what follows the new tail in.
    expect(shouldRepinOnSend({ keepPosition: true, detached: true })).toBe(true);
  });

  it('re-pins from a detached slice with the setting off', () => {
    expect(shouldRepinOnSend({ keepPosition: false, detached: true })).toBe(true);
  });
});
