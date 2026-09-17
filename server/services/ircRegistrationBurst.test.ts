// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The saved registration burst, which the bouncer replays to a client that
// attaches mid-session (IrcConnection.registrationLines). Servers re-send 005
// while connected — solanum sends its whole ISUPPORT again after every VERSION
// reply — and the burst used to grow by a copy each time, replaying the pile on
// every attach. Against a real IrcConnection and the fake ircd.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircd: FakeIrcd;
let userId: number;

beforeAll(async () => {
  ({ IrcConnection } = await import('./ircConnection.js'));
  ircd = await FakeIrcd.start({});
  userId = createUser('reg-burst').id;
});

afterAll(async () => {
  await ircd.close();
});

const isupport = (tokens: string) =>
  `:irc.example.test 005 burst ${tokens} :are supported by this server`;

describe('the saved registration burst', () => {
  it('keeps a later 005 once, however often the server repeats it', async () => {
    const network = createNetwork(userId, {
      name: 'burst',
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick: 'burst',
      autoconnect: false,
    })!;
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      const registered = conn.registrationLines.length;

      const repeated = isupport('AWAYLEN=200 CHANNELLEN=64');
      ircd.sendRaw('burst', repeated);
      await until(() => conn.registrationLines.length === registered + 1, 5000, 'the 005');
      // What solanum does after each VERSION, and a tag on the copy doesn't
      // make it a different line.
      ircd.sendRaw('burst', repeated);
      ircd.sendRaw('burst', `@time=2026-09-17T12:00:00.000Z ${repeated}`);
      // A token that CHANGED is news, and lands.
      const changed = isupport('AWAYLEN=300');
      ircd.sendRaw('burst', changed);
      await until(() => conn.registrationLines.length === registered + 2, 5000, 'the new 005');

      // No fourth line arrived behind the third: give the repeats a turn to.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(conn.registrationLines.length).toBe(registered + 2);
      expect(conn.registrationLines.filter((l) => l.endsWith(repeated))).toHaveLength(1);
      expect(conn.registrationLines.at(-1)).toBe(changed);
    } finally {
      conn.dispose();
    }
  });
});
