// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irc-framework raises one event, 'users online', for MONITOR's 730 and for
// an ISON reply (303). Only the 730 is presence: an ISON reply was taken for
// one, and on a network without MONITOR nothing marked the peer offline again
// (#933). Against a real IrcConnection and the fake ircd.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { getPeerPresence } from '../db/peerPresence.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircd: FakeIrcd;
let userId: number;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircd = await FakeIrcd.start({});
  userId = createUser('ison-presence').id;
});

afterAll(async () => {
  await ircd.close();
});

describe('peer presence', () => {
  it("comes from MONITOR's 730, never an ISON reply", async () => {
    const nick = 'isonwatch';
    const network = createNetwork(userId, {
      name: 'ison',
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick,
      autoconnect: false,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      conn.trackDmPeer('polled');
      conn.trackDmPeer('watched');
      // What /ison, or a bouncer client's notify list, gets back.
      ircd.sendRaw(nick, `:fake.test 303 ${nick} :polled`);
      // After it on the same socket, so once this lands the 303 was handled.
      ircd.sendRaw(nick, `:fake.test 730 ${nick} :watched!~w@peer.fake`);
      await until(
        () => getPeerPresence(network.id, 'watched')?.state === 'online',
        5000,
        'the 730 marks its peer online',
      );
      expect(getPeerPresence(network.id, 'polled')).toBeNull();
    } finally {
      conn.dispose();
    }
  });
});
