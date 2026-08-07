// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { screenForRoute } from './mobileScreen.js';

describe('screenForRoute', () => {
  it('shows the system console from /system, with or without an id', () => {
    // The app-scoped buffer routes by name because it exists before the server
    // answers — reachable while disconnected, which is when its log matters.
    expect(screenForRoute(undefined, false, true, true)).toBe('buffer');
    expect(screenForRoute(undefined, false, false, true)).toBe('buffer');
  });

  it.each([
    ['at /', undefined, false, true, 'list'],
    ['on a buffer', '7', false, true, 'buffer'],
    ['on its members list', '7', true, true, 'members'],
  ])('%s', (_label, id, isMembers, active, expected) => {
    expect(screenForRoute(id, isMembers as boolean, active as boolean)).toBe(expected);
  });

  it('shows an optimistically opened buffer that has no address yet', () => {
    // "Send DM" to a nick never messaged before creates a buffer with no row id,
    // and the server only mints one when a message is sent. Routing to `/`
    // stranded the user on the list with a DM they could not reach from it —
    // the composer they needed was on the screen they could not get to.
    expect(screenForRoute(undefined, false, true, false, true)).toBe('buffer');
    expect(screenForRoute('7', true, true, false, true)).toBe('buffer');
  });

  it('holds on the list while a routed buffer is still resolving', () => {
    // Cold launch from a bookmark or a notification: the route names a buffer
    // several seconds before the WS delivers it. Showing the buffer screen with
    // nothing in it looks like a broken app.
    expect(screenForRoute('7', false, false)).toBe('list');
    expect(screenForRoute('7', true, false)).toBe('list');
  });

  it('falls back to the list when the active buffer goes away', () => {
    // Closing the buffer (or removing its network) nulls activeKey. Stranding
    // the user on an empty buffer or a members list for a buffer that no longer
    // exists is the #137 bug.
    expect(screenForRoute('7', true, false)).toBe('list');
  });
});
