// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deleting a user disposes their connections and deletes the rows in the same
// tick, but a socket takes longer than that to die. Everything it still
// delivers reaches a connection whose network and user rows are already gone,
// and a write for either fails its foreign key — thrown from a socket event,
// that is an uncaught exception, and the process exits (#936). Against a real
// IrcConnection and the fake ircd, both ways it arrived:
//   - the socket's own close, which logged "Disconnected" for the user;
//   - a line the server sent before it read our QUIT, here a tracked peer's
//     QUIT, which wrote the peer's presence row.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createUser, deleteUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { ensureExists, setAutojoin } from '../db/buffers.js';
import * as systemLog from './systemLog.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

let ircManager: typeof import('./ircManager.js').default;
let ircd: FakeIrcd;
let seq = 0;

const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => uncaught.push(err);

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  ircd = await FakeIrcd.start({});
  process.on('uncaughtException', onUncaught);
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  await ircd.close();
});

afterEach(() => {
  ircd.hold = null;
  uncaught.length = 0;
});

async function liveUser(nick: string) {
  const user = createUser(`disposed-${seq++}`);
  const network = createNetwork(user.id, {
    name: `disposed-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
  const conn = ircManager.startNetwork(user.id, network.id)!;
  await until(() => conn.state === 'connected', 5000, 'connected');
  return { user, conn };
}

// The close handlers set the state before anything that writes, so this is
// true as soon as they have started; the macrotask lets them finish.
async function socketClosed(conn: { state: string }) {
  await until(() => conn.state === 'disconnected', 5000, 'socket closed');
  await new Promise((resolve) => setImmediate(resolve));
}

describe('a user deleted with a live connection', () => {
  it('survives the socket closing after the rows are gone', async () => {
    const { user, conn } = await liveUser('doomed');
    ircManager.disposeUser(user.id, 'user deleted');
    deleteUser(user.id);
    await socketClosed(conn);
    expect(uncaught).toEqual([]);
  });

  it('survives a line the server sent before it read the QUIT', async () => {
    const { user, conn } = await liveUser('doomed2');
    conn.trackDmPeer('buddy');
    ircd.hold = (cmd) => {
      if (cmd !== 'QUIT') return false;
      ircd.sendRaw('doomed2', ':buddy!~b@peer.fake QUIT :gone');
      ircd.drop('doomed2');
      return true;
    };
    ircManager.disposeUser(user.id, 'user deleted');
    deleteUser(user.id);
    await socketClosed(conn);
    expect(uncaught).toEqual([]);
  });
});

describe('a connection disposed while it registers', () => {
  it('rejoins nothing when the welcome arrives after the dispose', async () => {
    // A network edit mid-registration: the network's 001 was already on its
    // way when our QUIT went out. The rows are still there to rejoin from.
    const nick = 'midreg';
    const user = createUser(`disposed-${seq++}`);
    const network = createNetwork(user.id, {
      name: `disposed-${seq++}`,
      host: '127.0.0.1',
      port: ircd.port,
      tls: false,
      nick,
      autoconnect: false,
    })!;
    ensureExists(user.id, network.id, '#kept', { kind: 'channel' });
    setAutojoin(user.id, network.id, '#kept', true);
    const logged: string[] = [];
    const onLine = (line: unknown) => {
      const l = line as systemLog.LogLine;
      if (l.userId === user.id) logged.push(l.text);
    };
    systemLog.on('line', onLine);
    let userSent = false;
    ircd.hold = (cmd) => {
      if (cmd === 'USER') return (userSent = true);
      if (cmd !== 'QUIT' || !userSent) return false;
      ircd.sendRaw(nick, `:fake.test 001 ${nick} :Welcome`);
      ircd.drop(nick);
      return true;
    };
    try {
      const conn = ircManager.startNetwork(user.id, network.id)!;
      await until(() => userSent, 5000, 'USER sent');
      ircManager.disposeNetwork(user.id, network.id, 'reconnecting');
      await socketClosed(conn);
      expect(logged.filter((t) => t.startsWith('Auto-joining'))).toEqual([]);
    } finally {
      systemLog.off('line', onLine);
    }
  });
});
