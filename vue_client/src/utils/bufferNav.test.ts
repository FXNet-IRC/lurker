// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { shouldPushBuffer, shouldLeaveMembers } from './bufferNav.js';

describe('shouldPushBuffer', () => {
  it('navigates to somewhere new', () => {
    expect(shouldPushBuffer(7, null, null)).toBe(true);
    expect(shouldPushBuffer(7, 8, null)).toBe(true);
  });

  it('stays put when the route already names the buffer', () => {
    // The loop guard: a route-driven activation produces an outbound target
    // identical to the route that caused it, and has to stop there.
    expect(shouldPushBuffer(7, 7, null)).toBe(false);
  });

  it('stays put when a push to the same buffer is already in flight', () => {
    expect(shouldPushBuffer(7, null, 7)).toBe(false);
  });

  it('IGNORES the route while a push is in flight', () => {
    // THE regression. At /buffer/7, activating #b starts a push to /buffer/8
    // while the route still reads 7. Re-activating #a(7) then looks "already
    // there" against the stale route — so it skips, /buffer/8 lands, and the
    // inbound binding drags the user to #b. The in-flight target is the only
    // honest comparison while one exists.
    expect(shouldPushBuffer(7, 7, 8)).toBe(true);
  });
});

describe('shouldLeaveMembers', () => {
  it('holds when the activation IS the buffer the members route names', () => {
    // Cold refresh of /buffer/7/members: the snapshot resolves and
    // useBufferRoute activates buffer 7 — the route already names it, and
    // navigating for that bounced the user to the chat screen before the
    // members screen ever rendered.
    expect(shouldLeaveMembers(7, '7')).toBe(false);
  });

  it('leaves for an activation of a different buffer', () => {
    // Send DM out of the nick menu: holding would leave the user staring at
    // the old channel's member list.
    expect(shouldLeaveMembers(8, '7')).toBe(true);
  });

  it('leaves for an id-less activation, which can never be the routed buffer', () => {
    expect(shouldLeaveMembers(undefined, '7')).toBe(true);
    expect(shouldLeaveMembers(null, '7')).toBe(true);
  });
});
