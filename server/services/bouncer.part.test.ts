// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// PART through the bouncer, and what closing the window then means (#967).
//
// A client's PART goes to the network as it always did — it is a command the
// user typed, and the server's answer to it is theirs to see. What changed is
// the CLOSE that may follow: parting leaves the buffer in Lurker's list with
// its scrollback, and closing it there must not put a second PART on the wire,
// because a network answers one for a channel it knows we left with 442 — a
// line every attached client is handed, for a command nobody issued.
//
// Against a real IrcConnection on the fake ircd, which answers a non-member's
// PART with 442 exactly as a real one does, with the real bouncer in front.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-part');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let wsHub: typeof import('./wsHub.js');
let buffers: typeof import('../db/buffers.js');
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  wsHub = await import('./wsHub.js');
  buffers = await import('../db/buffers.js');
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({});
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Conn = import('./ircConnection.js').IrcConnection;

interface Account {
  userId: number;
  username: string;
  name: string;
  nick: string;
  networkId: number;
  conn: Conn;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
let seq = 0;

/** A user with one network, a real IrcConnection registered on the fake ircd. */
async function seedAccount(): Promise<Account> {
  seq += 1;
  const user = users.createUser(`part_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const name = 'neta';
  const nick = `part${seq}`;
  const network = networks.createNetwork(user.id, {
    name,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return { userId: user.id, username: user.username, name, nick, networkId: network.id, conn };
}

/** Log in over SASL to the account's network and wait out the welcome. */
async function attach(acct: Account): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send('CAP REQ :sasl');
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const login = `${acct.username}/${acct.name}`;
  c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

/** The fake ircd's connection for this nick. */
function fakeOf(nick: string) {
  const client = ircd.clients.filter((c) => c.nick === nick).at(-1);
  if (!client) throw new Error(`no ${nick} on the fake ircd`);
  return client;
}

/** Every PART Lurker put on the wire for this network. */
function partsSent(acct: Account): string[] {
  return fakeOf(acct.nick).sent.filter((line) => commandOf(line) === 'PART');
}

function state(acct: Account, target: string): string | undefined {
  return buffers.getState(acct.userId, acct.networkId, target);
}

let probeSeq = 0;

/**
 * A round trip through the network, after the line under test. The client's
 * NAMES is relayed upstream and its reply routed back here, so once the 366
 * lands, anything the ircd wrote earlier — a 442 answering a PART that should
 * never have gone out — has already reached this client. Without a barrier an
 * assertion that nothing arrived is just a race the fix happens to win.
 *
 * ⚠ A FRESH channel name every time. waitFor matches lines already received as
 * well as future ones, so a barrier naming a channel this client has seen
 * before (its own, replayed at attach with a 366 of its own) resolves on that
 * old line and waits for nothing — which is how this started out, passing
 * against a build with the fix removed.
 */
async function roundTrip(c: Client): Promise<void> {
  const probe = `#probe${++probeSeq}`;
  c.send(`NAMES ${probe}`);
  await c.waitFor((l) => commandOf(l) === '366' && l.includes(probe), 5000);
}

/** Join `#chan` through the account's connection and wait for the echo. */
async function join(acct: Account, chan: string): Promise<void> {
  ircManager.joinChannel(acct.userId, acct.networkId, chan);
  await until(() => acct.conn.isChannelJoined(chan), 5000, `joined ${chan}`);
  await until(() => state(acct, chan) === 'open', 5000, `${chan} buffer open`);
}

describe('bouncer PART, and the close that follows it', () => {
  it("a client's first PART leaves the channel and keeps the buffer", async () => {
    const acct = await seedAccount();
    await join(acct, '#leave');
    const c = await attach(acct);

    c.send('PART #leave');
    await until(() => !acct.conn.isChannelJoined('#leave'), 5000, 'parted #leave');

    expect(partsSent(acct)).toEqual(['PART #leave']);
    // The buffer stays, dimmed: the scrollback is still readable and the
    // channel no longer comes back on the next connect.
    expect(state(acct, '#leave')).toBe('open');
    expect(buffers.isAutojoin(acct.userId, acct.networkId, '#leave')).toBe(false);
  });

  it('a PART for a channel with no buffer still goes to the network', async () => {
    // ZNC forwards this case too (FindChan returns null): with no row there is
    // nothing to close, so the PART is a real command and the server's answer
    // to it is the user's to see. This is also what keeps `/part #chan` working
    // for a channel Lurker never surfaced.
    const acct = await seedAccount();
    const c = await attach(acct);

    c.send('PART #phantom');
    await until(() => partsSent(acct).length > 0, 5000, 'PART forwarded');

    expect(partsSent(acct)).toEqual(['PART #phantom']);
    expect(state(acct, '#phantom')).toBeUndefined();
  });

  it('closing the window after another client parted sends no PART (#967)', async () => {
    // The reported bug, end to end: halloy parts, the web app closes the now
    // dimmed window, and the redundant PART drew a 442 that the bouncer handed
    // to every attached client.
    const acct = await seedAccount();
    await join(acct, '#reported');
    const c = await attach(acct);

    c.send('PART #reported');
    await until(() => !acct.conn.isChannelJoined('#reported'), 5000, 'parted #reported');
    const afterPart = c.lines.length;

    // What `/close` and the Close Channel menu item both do.
    wsHub.closeBuffer(acct.userId, acct.networkId, '#reported');

    await roundTrip(c);

    expect(state(acct, '#reported')).toBe('closed');
    expect(partsSent(acct)).toEqual(['PART #reported']);
    expect(c.lines.slice(afterPart).filter((l) => commandOf(l) === '442')).toEqual([]);
  });
});
