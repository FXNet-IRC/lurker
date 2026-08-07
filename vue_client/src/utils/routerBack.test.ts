// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { backOrPush, canGoBack } from './routerBack.js';

function router() {
  return { back: vi.fn<() => void>(), push: vi.fn<(to: string) => Promise<void>>() } as any;
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('backOrPush', () => {
  it('goes back when there is an entry behind us', () => {
    window.history.replaceState({ back: '/buffer/7' }, '', '/buffer/7/members');
    const r = router();

    backOrPush(r, '/buffer/7');

    expect(r.back).toHaveBeenCalled();
    expect(r.push).not.toHaveBeenCalled();
  });

  it('navigates instead when this is the first entry', () => {
    // The case these screens only acquired by getting real URLs: opened cold —
    // refreshed, bookmarked, shared — history.back() would do nothing, or walk
    // out of Lurker altogether.
    window.history.replaceState({ back: null }, '', '/buffer/7/members');
    const r = router();

    backOrPush(r, '/buffer/7');

    expect(r.push).toHaveBeenCalledWith('/buffer/7');
    expect(r.back).not.toHaveBeenCalled();
  });

  it('treats a stateless entry as nothing to go back to', () => {
    window.history.replaceState(null, '', '/buffer/7/members');
    expect(canGoBack()).toBe(false);
  });
});
