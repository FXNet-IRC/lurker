// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import {
  setComposerOverlayHandlers,
  pickComposerFile,
  pickComposerCamera,
} from './useComposerOverlay.js';

// The registry is a module-level singleton with no-op defaults, so a dispatcher
// fired before MessageInput mounts is dropped rather than throwing. That's also
// why every "did the pick land" question has to be asked of the registered
// handler and not of a return value — these dispatchers return nothing, and a
// pick that reaches nobody is indistinguishable from one that worked.
describe('useComposerOverlay — attach dispatchers', () => {
  it('routes file and camera picks to separate handlers', () => {
    const onPickFile = vi.fn<() => void>();
    const onPickCamera = vi.fn<() => void>();
    setComposerOverlayHandlers({ onPickFile, onPickCamera });

    pickComposerFile();
    expect(onPickFile).toHaveBeenCalledTimes(1);
    expect(onPickCamera).not.toHaveBeenCalled();

    // ⚠ Not the same handler with a flag: each fronts its own hidden <input>,
    // because `capture` is read when the browser opens the picker and toggling it
    // per tap would race the very click it is meant to configure.
    pickComposerCamera();
    expect(onPickCamera).toHaveBeenCalledTimes(1);
    expect(onPickFile).toHaveBeenCalledTimes(1);
  });

  it('drops a pick that arrives before a composer has registered', () => {
    // Registration is skipped for undefined keys, so the defaults stand.
    expect(() => pickComposerFile()).not.toThrow();
    expect(() => pickComposerCamera()).not.toThrow();
  });
});
