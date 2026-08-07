// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { previewsEnabled } from './previews.js';

describe('previewsEnabled', () => {
  const withEnv = (value: string | undefined, run: () => void) => {
    const saved = process.env.LURKER_LINK_PREVIEWS;
    if (value === undefined) delete process.env.LURKER_LINK_PREVIEWS;
    else process.env.LURKER_LINK_PREVIEWS = value;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.LURKER_LINK_PREVIEWS;
      else process.env.LURKER_LINK_PREVIEWS = saved;
    }
  };

  it('defaults OFF — an upgrade must not start dialling arbitrary URLs', () => {
    // The whole feature is opt-in, not just the fetch: an operator who upgrades and does
    // nothing gets a server that never reaches out. The Lounge ships `prefetch: false` for the
    // same reason.
    withEnv(undefined, () => expect(previewsEnabled()).toBe(false));
    withEnv('', () => expect(previewsEnabled()).toBe(false));
  });

  it('is enabled only by an affirmative value', () => {
    for (const v of ['on', 'ON', '1', 'true', 'yes', ' on ']) {
      withEnv(v, () => expect(previewsEnabled()).toBe(true));
    }
  });

  it('treats anything else as off rather than guessing', () => {
    for (const v of ['off', '0', 'false', 'no', 'maybe', 'enabled?']) {
      withEnv(v, () => expect(previewsEnabled()).toBe(false));
    }
  });
});
