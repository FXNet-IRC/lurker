// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A server line without server-time gets one time, taken when it arrived, for
// everything it produces: the row it stores and the bouncer's copy of the line
// (IrcConnection.lineArrivedAt). With two clocks a moment apart, a MARKREAD
// naming the relayed line's time missed the stored row. Against a real
// IrcConnection and the fake ircd.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircd: FakeIrcd;
let userId: number;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircd = await FakeIrcd.start({});
  userId = createUser('line-arrival').id;
});

afterAll(async () => {
  await ircd.close();
});

// sendRaw adds no tags, so this line has no time of its own.
const UNTIMED = ':bob!~bob@peer.fake PRIVMSG arrival :untimed';

const isUntimedMessage = (e: Ev) => e.type === 'message' && e.text === 'untimed';

// Stands in for the work between a line's raw listeners and its handlers (every
// attached bouncer client's relay runs there): long enough that a second clock
// would read a later millisecond.
function burn(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

describe('a line without server-time', () => {
  it('stores its message at the time the bouncer relays it with', async () => {
    const network = createNetwork(userId, {
      name: 'arrival',
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick: 'arrival',
      autoconnect: false,
    })!;
    const events: Ev[] = [];
    const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
    conn.connect();
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      let relayedAt: Date | null = null;
      // Registered after IrcConnection's own raw listener, as the bouncer's is.
      // irc-framework hands raw listeners the line with its CRLF still on.
      conn.client.on('raw', (event: { from_server: boolean; line: string }) => {
        if (!event.from_server || event.line.replace(/[\r\n]+$/, '') !== UNTIMED) return;
        relayedAt = conn.lineArrivedAt;
        burn(3);
      });
      ircd.sendRaw('arrival', UNTIMED);
      await until(() => events.some(isUntimedMessage), 5000, 'the message');
      expect(relayedAt).not.toBeNull();
      expect(events.find(isUntimedMessage)!.time).toBe(relayedAt!.toISOString());
      // Cleared once the line's handlers ran, so a later event gets its own time.
      expect(conn.lineArrivedAt).toBeNull();
    } finally {
      conn.dispose();
    }
  });
});
