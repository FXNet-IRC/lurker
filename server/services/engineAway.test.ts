// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The account's away state across an engine re-attach. Nothing reaches the
// network while the link to the engine is down, so a change made then goes out
// when the restore completes. The network's 305/306 answer Lurker, so they write
// no server-buffer row.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import ircManager from './ircManager.js';
import { EngineLink } from './engineLink.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

const NICK = 'awayer';

let harness: EngineHarness;

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: 'engine-away-secret',
    // The link comes back after 1.5 s, well after the change below.
    env: { LURKER_ENGINE_RETRY_BASE_MS: '1500' },
  });
});

afterAll(async () => {
  await harness.stop();
});

describe('away across an engine re-attach', () => {
  it('sends a change made while the link was down once the restore completes', async () => {
    const { ircd, until } = harness;
    const user = createUser('engine-away');
    const network = createNetwork(user.id, {
      name: 'away',
      host: '127.0.0.1',
      port: ircd.port,
      tls: 0,
      nick: NICK,
      autoconnect: 0,
    })!;
    const events: Array<Record<string, unknown>> = [];
    const listener = (event: Record<string, unknown>) => {
      if (event.networkId === network.id) events.push(event);
    };
    ircManager.on('event', listener);
    try {
      const conn = ircManager.startNetwork(user.id, network.id)!;
      harness.tap(conn, NICK);
      await until(() => conn.state === 'connected', 5000, 'connected');
      const registrations = ircd.registrations.length;
      const fake = () => ircd.clients.find((c) => c.nick === NICK)!;
      const aways = () => fake().sent.filter((line) => /^AWAY( |$)/.test(line));
      const live = () => conn.state === 'connected' && !conn.restoring && !conn.catchingUp;
      let tokens = 0;
      // Every line Lurker sent before now has reached the ircd, and every line
      // the ircd sent back has reached Lurker.
      const settle = async () => {
        const token = `settle${++tokens}`;
        conn.client.raw(`PING ${token}`);
        await until(() => fake().sent.includes(`PING ${token}`), 5000, `${token} at the ircd`);
        ircd.sendRaw(NICK, `:fake.test NOTICE ${NICK} :${token}`);
        await until(() => events.some((e) => e.text === token), 5000, `${token} back`);
      };

      EngineLink.shared().simulateLoss();
      await until(() => conn.state !== 'connected', 5000, 'the link loss');
      ircManager.setAwayAll(user.id, 'gone while the link was down');
      await until(live, 20000, 'live again');
      await settle();
      expect(aways()).toEqual(['AWAY :gone while the link was down']);

      EngineLink.shared().simulateLoss();
      await until(() => conn.state !== 'connected', 5000, 'the second link loss');
      ircManager.clearAwayAll(user.id);
      await until(live, 20000, 'live again');
      await settle();
      expect(aways()).toEqual(['AWAY :gone while the link was down', 'AWAY']);

      // Both were re-attaches, not reconnects.
      expect(ircd.registrations).toHaveLength(registrations);
      expect(events.filter((e) => String(e.text ?? '').includes('marked as being away'))).toEqual(
        [],
      );
    } finally {
      ircManager.off('event', listener);
    }
  }, 90000);
});
