// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseForcedNetworkConfig, resolveConnectTarget } from './forcedNetwork.js';

describe('parseForcedNetworkConfig', () => {
  it('is disabled with an empty env', () => {
    const cfg = parseForcedNetworkConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('stays disabled when opted in but no host is configured', () => {
    const cfg = parseForcedNetworkConfig({ LURKER_LOCK_NETWORKS: 'true' });
    expect(cfg.enabled).toBe(false);
  });

  it('enables only with both the opt-in flag and a host', () => {
    const cfg = parseForcedNetworkConfig({
      LURKER_LOCK_NETWORKS: 'true',
      LURKER_FORCED_NETWORK_HOST: 'irc.fxnet.org',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe('irc.fxnet.org');
  });

  it('applies FXNet defaults for name, port, tls and channels', () => {
    const cfg = parseForcedNetworkConfig({
      LURKER_LOCK_NETWORKS: 'true',
      LURKER_FORCED_NETWORK_HOST: 'irc.fxnet.org',
    });
    expect(cfg.name).toBe('FXNet');
    expect(cfg.port).toBe(6697);
    expect(cfg.tls).toBe(true);
    expect(cfg.verifyTls).toBe(true);
    expect(cfg.channels).toEqual(['#chat', '#help', '#fxnet']);
  });

  it('honors explicit overrides', () => {
    const cfg = parseForcedNetworkConfig({
      LURKER_LOCK_NETWORKS: 'true',
      LURKER_FORCED_NETWORK_HOST: 'irc.example.test',
      LURKER_FORCED_NETWORK_NAME: 'Example',
      LURKER_FORCED_NETWORK_PORT: '6667',
      LURKER_FORCED_NETWORK_TLS: '0',
      LURKER_FORCED_NETWORK_CHANNELS: '#one, #two',
    });
    expect(cfg.name).toBe('Example');
    expect(cfg.port).toBe(6667);
    expect(cfg.tls).toBe(false);
    expect(cfg.channels).toEqual(['#one', '#two']);
  });

  it('treats a defined-but-empty channels var as no auto-join', () => {
    const cfg = parseForcedNetworkConfig({
      LURKER_LOCK_NETWORKS: 'true',
      LURKER_FORCED_NETWORK_HOST: 'irc.fxnet.org',
      LURKER_FORCED_NETWORK_CHANNELS: '',
    });
    expect(cfg.channels).toEqual([]);
  });

  it('falls back to the default port on a garbage value', () => {
    const cfg = parseForcedNetworkConfig({
      LURKER_LOCK_NETWORKS: 'true',
      LURKER_FORCED_NETWORK_HOST: 'irc.fxnet.org',
      LURKER_FORCED_NETWORK_PORT: 'not-a-number',
    });
    expect(cfg.port).toBe(6697);
  });
});

describe('resolveConnectTarget', () => {
  // resolveConnectTarget reads the process-cached config; with no env set the
  // lock is off, so it must mirror the stored row exactly (upstream behavior).
  it('passes through the stored row when the lock is off', () => {
    const target = resolveConnectTarget({
      host: 'irc.libera.chat',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
    });
    expect(target).toEqual({
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      rejectUnauthorized: true,
    });
  });

  it('reflects trusted_certificates=0 as rejectUnauthorized=false when unlocked', () => {
    const target = resolveConnectTarget({
      host: 'irc.libera.chat',
      port: 6697,
      tls: 1,
      trusted_certificates: 0,
    });
    expect(target.rejectUnauthorized).toBe(false);
  });
});
