// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { loadEngineConfig } from './config.js';

const base = { LURKER_ENGINE_SECRET: 's3cret' } as NodeJS.ProcessEnv;

describe('loadEngineConfig', () => {
  // The security-relevant default. LURKER_ENGINE_SECRET is the only thing
  // between a reachable engine and every connection it holds, so an engine
  // nobody configured must not be reachable off-box. Docker gets a wider bind
  // from the compose overlay (containers do not share a network namespace);
  // server/engine/topology.test.ts pins that the overlay actually sets it.
  it('binds loopback when nothing says otherwise', () => {
    const c = loadEngineConfig(base);
    expect(c.listenHost).toBe('127.0.0.1');
    expect(c.listenPort).toBe(8016);
  });

  it('honours an explicit bind, including a wide one', () => {
    expect(loadEngineConfig({ ...base, LURKER_ENGINE_LISTEN: '0.0.0.0:8016' }).listenHost).toBe(
      '0.0.0.0',
    );
    expect(loadEngineConfig({ ...base, LURKER_ENGINE_LISTEN: '9000' })).toMatchObject({
      listenHost: '127.0.0.1',
      listenPort: 9000,
    });
    expect(loadEngineConfig({ ...base, LURKER_ENGINE_LISTEN: '[::1]:9000' })).toMatchObject({
      listenHost: '::1',
      listenPort: 9000,
    });
  });

  it('refuses to start without a secret', () => {
    expect(() => loadEngineConfig({})).toThrow(/LURKER_ENGINE_SECRET is required/);
    expect(() => loadEngineConfig({ LURKER_ENGINE_SECRET: '   ' })).toThrow(/required/);
  });
});
