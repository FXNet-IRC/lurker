// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Away through the bouncer (the plan's "Away" section). A client's AWAY is the
// account's, on every network, as in the web and iOS apps, and every client hears
// a change as a 305 or 306. `AWAY *` (draft/pre-away) marks a connection that
// isn't the user, and any other attached client holds auto-away off. Against
// real IrcConnections on the fake ircd, with the real bouncer in front of them.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-away');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let presence: typeof import('./presence.js');
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let settings: typeof import('../db/settings.js');
let getUserAwayState: typeof import('../db/userAwayState.js').getUserAwayState;
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  // A network the fake ircd drops comes back after the 1 s reconnect floor, not
  // 2–5 s. Read when the connection module loads, so set before the imports below.
  process.env.LURKER_RECONNECT_BASE_MS = '50';
  process.env.LURKER_RECONNECT_JITTER_MS = '0';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  presence = await import('./presence.js');
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  settings = await import('../db/settings.js');
  ({ getUserAwayState } = await import('../db/userAwayState.js'));
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start({});
  harness = await harnessMod.startHarness();
});

afterAll(async () => {
  harness.stop();
  await ircd.close();
  ctx.cleanup();
  delete process.env.LURKER_RECONNECT_BASE_MS;
  delete process.env.LURKER_RECONNECT_JITTER_MS;
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

interface Net {
  name: string;
  nick: string;
  networkId: number;
  conn: Conn;
}

interface Account {
  userId: number;
  username: string;
  nets: Net[];
  // Everything the account's connections published.
  events: Array<Record<string, unknown>>;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
let seq = 0;

// A user with two networks, each a real IrcConnection registered on the fake ircd.
async function seedAccount(): Promise<Account> {
  seq += 1;
  const user = users.createUser(`away_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const events: Array<Record<string, unknown>> = [];
  const listener = (event: Record<string, unknown>) => {
    if (event.userId === user.id) events.push(event);
  };
  ircManager.on('event', listener);
  cleanups.push(() => ircManager.off('event', listener));
  const nets: Net[] = [];
  for (const name of ['neta', 'netb']) {
    const nick = `${name}${seq}`;
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
    await until(() => conn.state === 'connected', 5000, `${name} connected`);
    nets.push({ name, nick, networkId: network.id, conn });
  }
  return { userId: user.id, username: user.username, nets, events };
}

// Auto-away after 50 ms for this account. It's switched off again before the
// test's clients close, so no timer outlives the test.
function fastAutoAway(acct: Account): void {
  settings.setUserSetting(acct.userId, 'away.auto.delay_seconds', 0.05);
  cleanups.push(() => {
    settings.setUserSetting(acct.userId, 'away.auto.enabled', false);
    presence.clearAutoAway(acct.userId);
  });
}

// Log in over SASL to `network`, or register a control connection for null, send
// `before` ahead of CAP END, and wait for the end of the welcome.
async function attach(
  acct: Account,
  network: string | null,
  opts: { caps?: string; before?: string[] } = {},
): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${opts.caps ?? 'sasl'}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const login = network ? `${acct.username}/${network}` : acct.username;
  c.send(`AUTHENTICATE ${Buffer.from(['', login, PASSWORD].join(NUL)).toString('base64')}`);
  await c.waitForCommand('903');
  for (const line of opts.before ?? []) c.send(line);
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

const commandOf = (line: string) => harnessMod.commandOf(line);

// The fake ircd's latest connection with this nick: after a reconnect, the new one.
function fakeOf(nick: string) {
  const client = ircd.clients.filter((c) => c.nick === nick).at(-1);
  if (!client) throw new Error(`no ${nick} on the fake ircd`);
  return client;
}

// The AWAY lines a network's latest connection got from Lurker.
function aways(net: Net): string[] {
  return fakeOf(net.nick).sent.filter((line) => commandOf(line) === 'AWAY');
}

// The 305s and 306s a client got, from line `from` on.
function awayReplies(c: Client, from = 0): string[] {
  return c.lines.slice(from).filter((line) => ['305', '306'].includes(commandOf(line)));
}

function isAway(userId: number): boolean {
  const row = getUserAwayState(userId);
  return !!row?.away_datetime && !row.back_datetime;
}

// The server-buffer rows a network's connection published after `from`.
function rows(acct: Account, net: Net, from: number): unknown[] {
  return acct.events
    .slice(from)
    .filter((e) => e.type === 'motd' && e.networkId === net.networkId)
    .map((e) => e.text);
}

let tokens = 0;
// Every line the clients sent has been handled, every line Lurker sent the
// networks has arrived, and every line they sent back has reached Lurker and the
// clients. The bouncer answers a PING after the lines before it, and the fake
// ircd writes the NOTICE after the lines before it.
async function settle(acct: Account, clients: Client[]): Promise<void> {
  const token = `settle${++tokens}`;
  const pong = async (suffix: string) => {
    for (const c of clients) {
      c.send(`PING ${token}${suffix}`);
      await c.waitFor((l) => commandOf(l) === 'PONG' && l.endsWith(`:${token}${suffix}`));
    }
  };
  await pong('a');
  const live = acct.nets.filter((net) => net.conn.state === 'connected');
  for (const net of live) net.conn.client.raw(`PING ${token}`);
  await until(
    () => live.every((net) => fakeOf(net.nick).sent.includes(`PING ${token}`)),
    5000,
    `${token} at the ircd`,
  );
  for (const net of live) {
    ircd.sendRaw(net.nick, `:fake.test NOTICE ${net.nick} :${token}`);
    await until(
      () => acct.events.some((e) => e.networkId === net.networkId && e.text === token),
      5000,
      `${token} back from ${net.name}`,
    );
  }
  await pong('b');
}

describe('a client’s AWAY', () => {
  it('goes to every network, and every client hears it once, from the bouncer', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const c1 = await attach(acct, 'neta');
    const c2 = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [c1, c2, cb]);
    const marks = [c1, c2, cb].map((c) => c.lines.length);
    const published = acct.events.length;

    c1.send('AWAY :lunch');
    await settle(acct, [c1, c2, cb]);

    expect(aways(a)).toEqual(['AWAY :lunch']);
    expect(aways(b)).toEqual(['AWAY :lunch']);
    expect(getUserAwayState(acct.userId)).toMatchObject({
      away_message: 'lunch',
      back_datetime: null,
      auto_set: 0,
    });
    // c1's reply and the others' news are the bouncer's. The networks' 306s
    // answer Lurker, so they reach no client and write no server-buffer row.
    [c1, c2, cb].forEach((c, i) => {
      expect(awayReplies(c, marks[i])).toEqual([
        expect.stringMatching(/^:lurker\.bouncer 306 \S+ :You have been marked as being away$/),
      ]);
    });
    expect(acct.events.slice(published).filter((e) => e.type === 'motd')).toEqual([]);
  });

  it('sends a new message to the networks, and only the client that sent it hears back', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const c1 = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    c1.send('AWAY :lunch');
    await settle(acct, [c1, cb]);
    const marks = [c1.lines.length, cb.lines.length];

    c1.send('AWAY :dinner');
    await settle(acct, [c1, cb]);

    expect(aways(a)).toEqual(['AWAY :lunch', 'AWAY :dinner']);
    expect(aways(b)).toEqual(['AWAY :lunch', 'AWAY :dinner']);
    expect(awayReplies(c1, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(cb, marks[1])).toEqual([]);
  });

  it('answers a bare AWAY while not away, and sends the networks nothing', async () => {
    const acct = await seedAccount();
    const c = await attach(acct, 'neta');
    const mark = c.lines.length;

    c.send('AWAY');
    await settle(acct, [c]);

    expect(acct.nets.map(aways)).toEqual([[], []]);
    expect(awayReplies(c, mark)).toEqual([
      expect.stringMatching(/ 305 \S+ :You are no longer marked as being away$/),
    ]);
  });

  it('changes the account once when a client sends it on every network, as irssi does', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const ca = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [ca, cb]);
    const marks = [ca.lines.length, cb.lines.length];
    const published = acct.events.length;

    ca.send('AWAY :gone');
    cb.send('AWAY :gone');
    await settle(acct, [ca, cb]);

    expect(aways(a)).toEqual(['AWAY :gone']);
    expect(aways(b)).toEqual(['AWAY :gone']);
    // Each got its own 306, and whichever came second heard the first's change.
    const replies = [awayReplies(ca, marks[0]).length, awayReplies(cb, marks[1]).length];
    expect(replies.toSorted()).toEqual([1, 2]);
    // One change, so the apps' away divider moved once on each network.
    expect(acct.events.slice(published).filter((e) => e.type === 'away-state')).toHaveLength(2);
  });

  it('reaches every client when the apps change it, and a client’s bare AWAY undoes it', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const ca = await attach(acct, 'neta');
    const cb = await attach(acct, 'netb');
    await settle(acct, [ca, cb]);
    let marks = [ca.lines.length, cb.lines.length];

    ircManager.setAwayAll(acct.userId, 'from the apps');
    await settle(acct, [ca, cb]);
    expect(awayReplies(ca, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(cb, marks[1])).toEqual([expect.stringMatching(/ 306 /)]);
    marks = [ca.lines.length, cb.lines.length];

    cb.send('AWAY');
    await settle(acct, [ca, cb]);
    expect(isAway(acct.userId)).toBe(false);
    expect(aways(a)).toEqual(['AWAY :from the apps', 'AWAY']);
    expect(aways(b)).toEqual(['AWAY :from the apps', 'AWAY']);
    expect(awayReplies(ca, marks[0])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(awayReplies(cb, marks[1])).toEqual([expect.stringMatching(/ 305 /)]);
  });

  it('tells a client that attaches while away, after its channels, and a control connection too', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    a.conn.join('#away');
    await until(
      () => !!a.conn.channelState('#away') && !a.conn.membersPending('#away'),
      5000,
      'joined #away',
    );
    ircManager.setAwayAll(acct.userId, 'gone');

    const c = await attach(acct, 'neta');
    const control = await attach(acct, null);
    await settle(acct, [c, control]);

    const join = c.lines.findIndex((l) => commandOf(l) === 'JOIN');
    expect(join).toBeGreaterThan(-1);
    expect(c.lines.findIndex((l) => commandOf(l) === '306')).toBeGreaterThan(join);
    expect(awayReplies(c)).toHaveLength(1);
    expect(awayReplies(control)).toHaveLength(1);
  });

  it('works on a control connection, and with the network down', async () => {
    const acct = await seedAccount();
    const [a, b] = acct.nets;
    const control = await attach(acct, null);
    const c = await attach(acct, 'neta');
    await settle(acct, [control, c]);
    let marks = [control.lines.length, c.lines.length];

    control.send('AWAY :from control');
    await settle(acct, [control, c]);
    expect(isAway(acct.userId)).toBe(true);
    expect(aways(a)).toEqual(['AWAY :from control']);
    expect(awayReplies(control, marks[0])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(awayReplies(c, marks[1])).toEqual([expect.stringMatching(/ 306 /)]);
    expect(control.lines.slice(marks[0]).filter((l) => commandOf(l) === 'NOTICE')).toEqual([]);

    a.conn.disconnect();
    await until(() => a.conn.state === 'disconnected', 5000, 'neta down');
    await settle(acct, [control, c]);
    marks = [control.lines.length, c.lines.length];

    c.send('AWAY');
    await settle(acct, [control, c]);
    expect(isAway(acct.userId)).toBe(false);
    expect(awayReplies(c, marks[1])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(awayReplies(control, marks[0])).toEqual([expect.stringMatching(/ 305 /)]);
    expect(aways(a)).toEqual(['AWAY :from control']);
    expect(aways(b)).toEqual(['AWAY :from control', 'AWAY']);
  });
});

describe('the AWAY Lurker sends', () => {
  it('keeps its 306 apart from the reply to an AWAY the user sent raw', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    await settle(acct, []);
    const published = acct.events.length;

    // Lurker's AWAY goes out first, then a bare one the user typed. The network
    // answers in that order, and only the second answer is the user's to see.
    ircManager.setAwayAll(acct.userId, 'lunch');
    a.conn.raw('AWAY', 'user');
    await settle(acct, []);

    expect(rows(acct, a, published)).toEqual([
      expect.stringMatching(/no longer marked as being away/),
    ]);
  });

  it('sends the account’s away again when a network reconnects', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAwayAll(acct.userId, 'lunch');
    await settle(acct, []);
    const before = fakeOf(a.nick);
    const published = acct.events.length;

    ircd.drop(a.nick, false);
    await until(
      () => fakeOf(a.nick) !== before && a.conn.state === 'connected',
      10000,
      'neta reconnected',
    );
    await settle(acct, []);

    expect(aways(a)).toEqual(['AWAY :lunch']);
    expect(rows(acct, a, published).filter((t) => /marked as being away/.test(String(t)))).toEqual(
      [],
    );
  });

  it('sends a message with a line break in it as one line', async () => {
    const acct = await seedAccount();
    const [a] = acct.nets;
    ircManager.setAwayAll(acct.userId, 'out\nPRIVMSG #elsewhere :injected');
    await settle(acct, []);

    expect(aways(a)).toEqual(['AWAY :out PRIVMSG #elsewhere :injected']);
    expect(fakeOf(a.nick).sent.filter((l) => commandOf(l) === 'PRIVMSG')).toEqual([]);
  });

  it('sends nothing for an away with nothing left to say once the line is made safe', async () => {
    const acct = await seedAccount();
    // A NUL survives the trim, and becomes a space the line then loses. A bare
    // AWAY in its place would clear the networks' away while the account is away.
    ircManager.setAwayAll(acct.userId, String.fromCharCode(0));
    await settle(acct, []);

    expect(isAway(acct.userId)).toBe(true);
    expect(acct.nets.map(aways)).toEqual([[], []]);
  });
});

describe('draft/pre-away', () => {
  it('is offered', async () => {
    const c = await harness.connect();
    cleanups.push(() => c.close());
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls.replace(/^.* :/, '').split(' ')).toContain('draft/pre-away');
  });

  it('takes goguma’s AWAY * before CAP END, and leaves the account and auto-away alone', async () => {
    const acct = await seedAccount();
    ircManager.setAwayAll(acct.userId, 'afk', { autoSet: true });

    // goguma's background sync, as it connects.
    const sync = await attach(acct, 'neta', {
      caps: 'sasl draft/pre-away',
      before: ['AWAY *'],
    });
    await settle(acct, [sync]);

    // Its 306 came before the welcome, and the burst didn't repeat it.
    const reply = sync.lines.findIndex((l) => commandOf(l) === '306');
    expect(reply).toBeGreaterThan(-1);
    expect(reply).toBeLessThan(sync.lines.findIndex((l) => commandOf(l) === '001'));
    expect(awayReplies(sync)).toHaveLength(1);
    // It isn't the user, so the auto-away it found stays, and no `*` goes out.
    expect(getUserAwayState(acct.userId)).toMatchObject({
      away_message: 'afk',
      back_datetime: null,
      auto_set: 1,
    });
    expect(acct.nets.map(aways)).toEqual([['AWAY :afk'], ['AWAY :afk']]);

    // A client that is the user brings the account back.
    await attach(acct, 'netb');
    expect(isAway(acct.userId)).toBe(false);
  });

  it('takes AWAY * after registration from a client without the cap', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    const c = await attach(acct, 'neta');
    const mark = c.lines.length;

    c.send('AWAY *');
    await settle(acct, [c]);
    expect(awayReplies(c, mark)).toEqual([expect.stringMatching(/ 306 /)]);

    // Nothing counts as the user now, so auto-away comes, with its own message.
    await until(() => isAway(acct.userId), 2000, 'auto-away');
    const row = getUserAwayState(acct.userId)!;
    expect(row.auto_set).toBe(1);
    expect(row.away_message).toMatch(/^afk since /);
    expect(acct.nets.flatMap(aways).filter((l) => l.endsWith('*'))).toEqual([]);
  });

  it('applies an AWAY sent before registration once the account is known', async () => {
    const acct = await seedAccount();
    const c = await attach(acct, 'neta', { before: ['AWAY :early'] });
    await settle(acct, [c]);
    // One 306: its reply. The burst doesn't repeat it.
    expect(awayReplies(c)).toHaveLength(1);
    expect(getUserAwayState(acct.userId)).toMatchObject({
      away_message: 'early',
      back_datetime: null,
      auto_set: 0,
    });
    expect(acct.nets.map(aways)).toEqual([['AWAY :early'], ['AWAY :early']]);
  });
});

describe('auto-away', () => {
  it('is held off by an attached client, and starts when the last one goes', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    ircManager.setAwayAll(acct.userId, 'afk', { autoSet: true });

    const c = await attach(acct, 'neta');
    expect(isAway(acct.userId)).toBe(false);

    c.close();
    await until(() => isAway(acct.userId), 2000, 'auto-away');
    expect(getUserAwayState(acct.userId)?.auto_set).toBe(1);
  });

  it('isn’t held off by a control connection or an AWAY * client', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    await attach(acct, null);
    await attach(acct, 'neta', { caps: 'sasl draft/pre-away', before: ['AWAY *'] });
    await until(() => isAway(acct.userId), 2000, 'auto-away');
    expect(getUserAwayState(acct.userId)?.auto_set).toBe(1);
  });

  it('doesn’t come for an account paused while its clients were attached', async () => {
    const acct = await seedAccount();
    fastAutoAway(acct);
    await attach(acct, 'neta');

    // Pausing the account drops its clients, and each one reports leaving.
    users.setUserPaused(acct.userId, true);
    ircManager.suspendUser(acct.userId);
    // Well past the delay.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(isAway(acct.userId)).toBe(false);
  });

  it('never replaces an away already set', async () => {
    const acct = await seedAccount();
    ircManager.setAwayAll(acct.userId, 'afk since earlier', { autoSet: true });
    expect(ircManager.setAwayAll(acct.userId, 'afk since later', { autoSet: true })).toBe(0);
    expect(getUserAwayState(acct.userId)?.away_message).toBe('afk since earlier');

    ircManager.setAwayAll(acct.userId, 'lunch');
    expect(ircManager.setAwayAll(acct.userId, 'afk', { autoSet: true })).toBe(0);
    expect(getUserAwayState(acct.userId)).toMatchObject({ away_message: 'lunch', auto_set: 0 });
  });
});
