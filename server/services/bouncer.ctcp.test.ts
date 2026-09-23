// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CTCP through the bouncer (#932, the plan's "CTCP answers"). One side answers
// a request, as in ZNC: the IRC clients attached to that network, which are
// sent it, or Lurker, from the user's settings. A setting the user changed keeps
// its type Lurker's. A client's VERSION reply goes out with "via Lurker". Against
// real IrcConnections on the fake ircd, with the real bouncer in front and a
// real peer asking, so the raw listener and the relay run in their real order.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-ctcp');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let settingsService: typeof import('./settingsService.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let via: string;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  settingsService = (await import('./settingsService.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  const { APP_NAME, APP_VERSION } = await import('../utils/userAgent.js');
  via = `via ${APP_NAME} ${APP_VERSION}`;
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

interface Peer {
  nick: string;
  lines: string[];
  send: (line: string) => void;
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
}

const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);
const A = String.fromCharCode(1);
let seq = 0;

// A user with real IrcConnections registered on the fake ircd, one per name.
async function seedAccount(names = ['neta']): Promise<Account> {
  seq += 1;
  const user = users.createUser(`ctcp_${seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  const events: Array<Record<string, unknown>> = [];
  const listener = (event: Record<string, unknown>) => {
    if (event.userId === user.id) events.push(event);
  };
  ircManager.on('event', listener);
  cleanups.push(() => ircManager.off('event', listener));
  const nets: Net[] = [];
  for (const name of names) {
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

// Another user on the fake ircd, who asks and sees what comes back. Each peer is
// its own ident, so its own allowance with Lurker's CTCP limiter.
async function peer(): Promise<Peer> {
  const nick = `asker${++seq}`;
  const p = await rawClient(ircd.port, nick);
  cleanups.push(() => p.socket.destroy());
  return { nick, lines: p.lines, send: p.send, waitFor: p.waitFor };
}

const commandOf = (line: string) => harnessMod.commandOf(line);

function ask(p: Peer, net: Net, request: string): void {
  p.send(`PRIVMSG ${net.nick} :${A}${request}${A}`);
}

// The CTCP replies a peer got, as `<from> <reply>`.
function replies(p: Peer): string[] {
  return p.lines.flatMap((line) => {
    const at = line.indexOf(` :${A}`);
    if (commandOf(line) !== 'NOTICE' || at === -1) return [];
    const from = line
      .replace(/^@\S+ /, '')
      .slice(1)
      .split('!')[0];
    return [`${from} ${line.slice(at + 3).split(A)[0]}`];
  });
}

// The CTCP request types a client was sent.
function requests(c: Client): string[] {
  return c.lines.flatMap((line) => {
    const at = line.indexOf(` :${A}`);
    if (commandOf(line) !== 'PRIVMSG' || at === -1) return [];
    return [
      line
        .slice(at + 3)
        .split(A)[0]
        .split(' ')[0],
    ];
  });
}

// The CTCP status lines a network's connection published for the apps.
function statusLines(acct: Account, net: Net): unknown[] {
  return acct.events
    .filter((e) => e.type === 'ctcp' && e.networkId === net.networkId)
    .map((e) => e.text);
}

let tokens = 0;
// Every line so far has been handled: the bouncer read each client's lines,
// Lurker read the peer's, each client got what the relay sent, and the peer got
// what Lurker sent back. Each marker follows the lines it waits behind.
async function settle(p: Peer, net: Net, acct: Account, clients: Client[] = []): Promise<void> {
  const token = `settle${++tokens}`;
  for (const c of clients) {
    c.send(`PING ${token}`);
    await c.waitFor((l) => commandOf(l) === 'PONG' && l.endsWith(`:${token}`));
  }
  p.send(`PRIVMSG ${net.nick} :${token}`);
  await until(
    () => acct.events.some((e) => e.networkId === net.networkId && e.text === token),
    5000,
    `${token} at Lurker`,
  );
  for (const c of clients) await c.waitFor((l) => l.endsWith(` :${token}`));
  net.conn.client.raw(`PRIVMSG ${p.nick} :${token}back`);
  await p.waitFor(new RegExp(`:${token}back$`));
}

describe('who answers a CTCP request', () => {
  it('is Lurker while no IRC client is attached, as before', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct);

    expect(replies(p)).toEqual([expect.stringMatching(new RegExp(`^${net.nick} VERSION Lurker `))]);
    expect(statusLines(acct, net)).toEqual([
      expect.stringMatching(new RegExp(`^${p.nick} requested CTCP VERSION \\(replied: Lurker `)),
    ]);
  });

  it('is the attached client, whose VERSION reply goes out with "via Lurker"', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct, [c]);
    expect(requests(c)).toEqual(['VERSION']);
    expect(replies(p)).toEqual([]);
    expect(statusLines(acct, net)).toEqual([
      `${p.nick} requested CTCP VERSION (forwarded to your IRC client)`,
    ]);

    // ZNC's scenario: the client answers, and the bouncer adds itself.
    c.send(`NOTICE ${p.nick} :${A}VERSION halloy 1${A}`);
    await settle(p, net, acct, [c]);
    expect(replies(p)).toEqual([`${net.nick} VERSION halloy 1 ${via}`]);
  });

  it('sends a client’s own VERSION request as it was, with no "via"', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');
    const p = await peer();

    c.send(`PRIVMSG ${p.nick} :${A}VERSION${A}`);
    await settle(p, net, acct, [c]);

    const received = p.lines.filter((line) => commandOf(line) === 'PRIVMSG' && line.includes(A));
    expect(received.map((line) => line.slice(line.indexOf(' PRIVMSG ') + 1))).toEqual([
      `PRIVMSG ${p.nick} :${A}VERSION${A}`,
    ]);
  });

  it('is the attached client for every type Lurker answers, and nobody if it stays quiet', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');

    const answered: string[] = [];
    for (const request of ['PING 123', 'TIME', 'SOURCE', 'CLIENTINFO']) {
      const p = await peer();
      ask(p, net, request);
      await settle(p, net, acct, [c]);
      answered.push(...replies(p));
    }
    expect(requests(c)).toEqual(['PING', 'TIME', 'SOURCE', 'CLIENTINFO']);
    expect(answered).toEqual([]);
  });

  it('goes back to Lurker when the last client detaches', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');
    c.close();
    await until(
      () => bouncerMod.attachedSessionCount(acct.userId, net.networkId) === 0,
      5000,
      'client detached',
    );
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct);

    expect(replies(p)).toEqual([expect.stringMatching(new RegExp(`^${net.nick} VERSION Lurker `))]);
  });

  it('is Lurker once the network restarts under a client that has sent nothing since', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');
    // A network edit, or Reconnect in the web app.
    const conn = ircManager.restartNetwork(acct.userId, net.networkId, 'edited')!;
    cleanups.push(() => conn.dispose());
    await until(() => conn.state === 'connected', 5000, 'restarted');
    const restarted = { ...net, nick: conn.currentNick, conn };
    const p = await peer();

    ask(p, restarted, 'VERSION');
    await settle(p, restarted, acct);

    // The bouncer dropped the client left on the old connection as soon as the
    // new one started (onUpstreamState), so no client counts and Lurker answers.
    expect(c.lines).toContain('ERROR :Upstream connection was reset — reconnect to reattach');
    expect(requests(c)).toEqual([]);
    expect(replies(p)).toEqual([
      expect.stringMatching(new RegExp(`^${restarted.nick} VERSION Lurker `)),
    ]);
  });

  it('answers each request in a batch, taking the allowance once for each', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const p = await peer();
    const from = `:${p.nick}!~${p.nick}@peer.fake`;

    // irc-framework runs a batch's lines only when the batch ends.
    ircd.sendRaw(net.nick, ':fake.test BATCH +b1 example.test/batch');
    for (let i = 0; i < 3; i++) {
      ircd.sendRaw(net.nick, `@batch=b1 ${from} PRIVMSG ${net.nick} :${A}VERSION${A}`);
    }
    ircd.sendRaw(net.nick, ':fake.test BATCH -b1');
    await settle(p, net, acct);

    // Three a minute from one peer, and three asked.
    expect(replies(p)).toHaveLength(3);
  });

  it('leaves a type Lurker has no answer for as it was: the client gets it, nobody answers', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const alone = await peer();
    ask(alone, net, 'USERINFO');
    await settle(alone, net, acct);
    expect(replies(alone)).toEqual([]);

    const c = await attach(acct, 'neta');
    const p = await peer();
    ask(p, net, 'USERINFO');
    await settle(p, net, acct, [c]);
    expect(requests(c)).toEqual(['USERINFO']);
    expect(replies(p)).toEqual([]);
  });
});

describe('a changed CTCP setting keeps its type Lurker’s', () => {
  it('answers VERSION with the changed reply, sends the client only the other types, and adds no "via"', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    settingsService.update(acct.userId, { 'ctcp.version': 'my client' });
    const c = await attach(acct, 'neta');

    const p = await peer();
    ask(p, net, 'VERSION');
    await settle(p, net, acct, [c]);
    expect(replies(p)).toEqual([`${net.nick} VERSION my client`]);

    const q = await peer();
    ask(q, net, 'TIME');
    await settle(q, net, acct, [c]);
    expect(replies(q)).toEqual([]);
    expect(requests(c)).toEqual(['TIME']);

    // A VERSION reply the client sends anyway doesn't give away Lurker's.
    c.send(`NOTICE ${q.nick} :${A}VERSION halloy 1${A}`);
    await settle(q, net, acct, [c]);
    expect(replies(q)).toEqual([`${net.nick} VERSION halloy 1`]);
  });

  it('answers nothing, and sends the client nothing, with an empty VERSION reply', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    settingsService.update(acct.userId, { 'ctcp.version': '' });
    const c = await attach(acct, 'neta');
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct, [c]);

    expect(replies(p)).toEqual([]);
    expect(requests(c)).toEqual([]);
  });

  it('answers nothing, and sends the client nothing, with replies turned off', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    settingsService.update(acct.userId, { 'ctcp.replies': false });
    const c = await attach(acct, 'neta');

    const answered: string[] = [];
    for (const request of ['VERSION', 'PING 1']) {
      const p = await peer();
      ask(p, net, request);
      await settle(p, net, acct, [c]);
      answered.push(...replies(p));
    }
    expect(answered).toEqual([]);
    expect(requests(c)).toEqual([]);
  });
});

describe('what counts as an attached client', () => {
  it('not a connection that sent AWAY *, like goguma’s background sync', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const sync = await attach(acct, 'neta', {
      caps: 'sasl draft/pre-away',
      before: ['AWAY *'],
    });
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct, [sync]);

    expect(replies(p)).toEqual([expect.stringMatching(new RegExp(`^${net.nick} VERSION Lurker `))]);
    expect(requests(sync)).toEqual([]);
  });

  it('not a control connection', async () => {
    // A login that names no network is bound to an account's only one, so this
    // account has two.
    const acct = await seedAccount(['neta', 'netb']);
    const [net] = acct.nets;
    await attach(acct, null);
    const p = await peer();

    ask(p, net, 'VERSION');
    await settle(p, net, acct);

    expect(replies(p)).toEqual([expect.stringMatching(new RegExp(`^${net.nick} VERSION Lurker `))]);
  });

  it('only on its own network', async () => {
    const acct = await seedAccount(['neta', 'netb']);
    const [a, b] = acct.nets;
    const c = await attach(acct, 'neta');

    const p = await peer();
    ask(p, b, 'VERSION');
    await settle(p, b, acct);
    expect(replies(p)).toEqual([expect.stringMatching(new RegExp(`^${b.nick} VERSION Lurker `))]);

    const q = await peer();
    ask(q, a, 'VERSION');
    await settle(q, a, acct, [c]);
    expect(replies(q)).toEqual([]);
    expect(requests(c)).toEqual(['VERSION']);
  });
});

describe('the CTCP limit', () => {
  it('covers requests sent to the client, once each', async () => {
    const acct = await seedAccount();
    const [net] = acct.nets;
    const c = await attach(acct, 'neta');
    const p = await peer();

    for (let i = 0; i < 4; i++) ask(p, net, 'VERSION');
    await settle(p, net, acct, [c]);

    // Three a minute from one peer (e2e/rateLimiter.ts). One more is neither
    // answered nor sent on.
    expect(requests(c)).toEqual(['VERSION', 'VERSION', 'VERSION']);
    expect(replies(p)).toEqual([]);
  });
});
