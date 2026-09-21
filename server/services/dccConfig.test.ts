// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createUser } from '../db/users.js';
import { CAPABILITY_DCC, setUserCapability } from '../db/userCapabilities.js';
import {
  dccActiveListenAvailable,
  dccAllowPrivateHosts,
  dccEnabledForUser,
  dccMasterEnabled,
  dccMaxFileBytes,
  parseDccEnabled,
} from './dccConfig.js';

describe('parseDccEnabled', () => {
  it('treats the conventional truthy values as on (trimmed, case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(parseDccEnabled(v)).toBe(true);
    }
  });

  it('is off for unset / empty / anything else (opt-in only)', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(parseDccEnabled(v)).toBe(false);
    }
  });
});

describe('dcc gate', () => {
  let userId: number;
  beforeAll(() => {
    userId = createUser('gate-alice').id;
  });
  afterEach(() => {
    delete process.env.LURKER_DCC_ENABLED;
    delete process.env.LURKER_DCC_MAX_FILE_MB;
    delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  });

  it('reads the master switch live from LURKER_DCC_ENABLED', () => {
    delete process.env.LURKER_DCC_ENABLED;
    expect(dccMasterEnabled()).toBe(false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccMasterEnabled()).toBe(true);
  });

  it('requires BOTH the master switch and a per-user grant', () => {
    // neither
    expect(dccEnabledForUser(userId)).toBe(false);
    // grant only
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(false);
    // master only
    setUserCapability(userId, CAPABILITY_DCC, false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccEnabledForUser(userId)).toBe(false);
    // both
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(true);
  });
});

describe('dccMaxFileBytes', () => {
  afterEach(() => delete process.env.LURKER_DCC_MAX_FILE_MB);

  it('is 0 (no cap) when unset / non-positive / unparseable', () => {
    expect(dccMaxFileBytes()).toBe(0);
    for (const v of ['0', '-5', 'abc', '']) {
      process.env.LURKER_DCC_MAX_FILE_MB = v;
      expect(dccMaxFileBytes()).toBe(0);
    }
  });

  it('converts MB to bytes', () => {
    process.env.LURKER_DCC_MAX_FILE_MB = '100';
    expect(dccMaxFileBytes()).toBe(100 * 1024 * 1024);
  });
});

describe('dccAllowPrivateHosts', () => {
  afterEach(() => delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS);

  it('defaults to off and honors the truthy set', () => {
    expect(dccAllowPrivateHosts()).toBe(false);
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    expect(dccAllowPrivateHosts()).toBe(true);
  });
});

// Copilot's second pass on #973: "invalid IPv6 configuration validation".
// dccActiveListenAvailable is what decides whether the server may make active
// offers, so a host that can't go on the wire has to read as NOT configured —
// otherwise every offer advertises an address nobody can dial.
describe('dccActiveListenAvailable', () => {
  const setRange = () => {
    process.env.LURKER_DCC_LISTEN_PORT_MIN = '30000';
    process.env.LURKER_DCC_LISTEN_PORT_MAX = '30009';
  };
  afterEach(() => {
    delete process.env.LURKER_DCC_EXTERNAL_HOST;
    delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
    delete process.env.LURKER_DCC_LISTEN_PORT_MAX;
  });

  it.each(['203.0.113.5', '2001:db8::1'])('is available with a usable address: %s', (host) => {
    setRange();
    process.env.LURKER_DCC_EXTERNAL_HOST = host;
    expect(dccActiveListenAvailable()).toBe(true);
  });

  // ⚠ `1.2.3.4:5` — host:port pasted into the setting — is the realistic slip.
  it.each(['1.2.3.4:5', '1:2', ':::', 'dcc.example.com'])(
    'is NOT available when the host cannot go on the wire: %s',
    (host) => {
      setRange();
      process.env.LURKER_DCC_EXTERNAL_HOST = host;
      expect(dccActiveListenAvailable()).toBe(false);
    },
  );
});
