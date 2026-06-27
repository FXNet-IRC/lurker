// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parsePublicModeConfig } from './publicMode.js';

describe('parsePublicModeConfig', () => {
  it('is disabled with an empty env', () => {
    const cfg = parsePublicModeConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('enables only on the exact opt-in flag', () => {
    expect(parsePublicModeConfig({ LURKER_PUBLIC_MODE: 'true' }).enabled).toBe(true);
    expect(parsePublicModeConfig({ LURKER_PUBLIC_MODE: 'TRUE' }).enabled).toBe(true);
    expect(parsePublicModeConfig({ LURKER_PUBLIC_MODE: '1' }).enabled).toBe(false);
    expect(parsePublicModeConfig({ LURKER_PUBLIC_MODE: 'yes' }).enabled).toBe(false);
  });

  it('applies default idle and rate-limit values', () => {
    const cfg = parsePublicModeConfig({ LURKER_PUBLIC_MODE: 'true' });
    expect(cfg.idleMinutes).toBe(30);
    expect(cfg.rateLimitPerIp).toBe(5);
  });

  it('honors positive integer overrides', () => {
    const cfg = parsePublicModeConfig({
      LURKER_PUBLIC_MODE: 'true',
      LURKER_GUEST_IDLE_MINUTES: '90',
      LURKER_GUEST_RATELIMIT_PER_IP: '20',
    });
    expect(cfg.idleMinutes).toBe(90);
    expect(cfg.rateLimitPerIp).toBe(20);
  });

  it('falls back to defaults on garbage or non-positive values', () => {
    const cfg = parsePublicModeConfig({
      LURKER_GUEST_IDLE_MINUTES: 'soon',
      LURKER_GUEST_RATELIMIT_PER_IP: '0',
    });
    expect(cfg.idleMinutes).toBe(30);
    expect(cfg.rateLimitPerIp).toBe(5);
  });
});
