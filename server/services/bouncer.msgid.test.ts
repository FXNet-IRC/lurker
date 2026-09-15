// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A message keeps the network's msgid everywhere an attached client sees it:
// live, as the echo of a message the user sent, and from CHATHISTORY. Against a
// real IrcConnection on the fake ircd, with the real bouncer in front of it. See
// bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

const ctx = setupTestDb('services-bouncer-msgid');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let users: typeof import('../db/users.js');
let networks: typeof import('../db/networks.js');
let hashPassword: typeof import('./password.js').hashPassword;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Event = Record<string, unknown>;

interface Live {
  userId: number;
  username: string;
  networkId: number;
  password: string;
  events: Event[];
}

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  users = await import('../db/users.js');
  networks = await import('../db/networks.js');
  ({ hashPassword } = await import('./password.js'));
  ircd = await FakeIrcd.start();
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

let seq = 0;

// A user whose network is a real IrcConnection, registered on the fake ircd.
async function seedLive(): Promise<Live> {
  seq += 1;
  const password = 'hunter2hunter2';
  const user = users.createUser(`msgid_${seq}`);
  users.setPasswordHash(user.id, hashPassword(password));
  const network = networks.createNetwork(user.id, {
    name: 'fake',
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick: `lurk${seq}`,
    autoconnect: false,
  } as Parameters<typeof networks.createNetwork>[1])!;
  const events: Event[] = [];
  const listener = (event: Event) => {
    if (event.networkId === network.id) events.push(event);
  };
  ircManager.on('event', listener);
  const conn = ircManager.startNetwork(user.id, network.id)!;
  cleanups.push(() => {
    ircManager.off('event', listener);
    conn.dispose();
    ircManager.connectionsForUser(user.id).delete(network.id);
  });
  await until(() => conn.state === 'connected', 5000, 'connected');
  return { userId: user.id, username: user.username, networkId: network.id, password, events };
}

const NUL = String.fromCharCode(0);
const CAPS = 'sasl batch server-time message-tags echo-message draft/chathistory';

// Attach, then join `channel` from the client.
async function attachIn(live: Live, channel: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${CAPS}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', live.username, live.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  c.send(`JOIN ${channel}`);
  await c.waitFor((l) => l.includes(' 366 ') && l.includes(` ${channel} `));
  return c;
}

function msgidOf(line: string): string | undefined {
  if (!line.startsWith('@')) return undefined;
  const tag = line
    .slice(1, line.indexOf(' '))
    .split(';')
    .find((t) => t.startsWith('msgid='));
  return tag?.slice('msgid='.length);
}

// The stored copy of a message, once the connection has published it.
async function stored(live: Live, text: string): Promise<Event> {
  await until(
    () => live.events.some((e) => e.text === text && e.id != null),
    5000,
    `stored: ${text}`,
  );
  return live.events.find((e) => e.text === text && e.id != null)!;
}

// The line CHATHISTORY returns for `text`.
async function fromHistory(c: Client, channel: string, text: string): Promise<string> {
  c.send(`CHATHISTORY LATEST ${channel} * 50`);
  return c.waitFor((l) => l.includes('batch=') && l.includes(`PRIVMSG ${channel} :${text}`));
}

describe('network msgids', () => {
  it("a peer's message has the network's msgid live and from history", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    const msgid = ircd.say('bob', '#room', 'hello there');
    const relayed = await c.waitFor((l) => l.includes('PRIVMSG #room :hello there'));
    expect(msgidOf(relayed)).toBe(msgid);
    await stored(live, 'hello there');
    expect(msgidOf(await fromHistory(c, '#room', 'hello there'))).toBe(msgid);
  });

  it("the client's own message has the network's msgid in its echo and from history", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    c.send('PRIVMSG #room :my own words');
    const echo = await c.waitFor((l) => l.includes('PRIVMSG #room :my own words'));
    const row = await stored(live, 'my own words');
    // The row took the network's msgid from its echo (echo-message).
    expect(String(row.msgid)).toMatch(/^m[0-9]+$/);
    expect(msgidOf(echo)).toBe(row.msgid);
    expect(msgidOf(await fromHistory(c, '#room', 'my own words'))).toBe(row.msgid);
  });

  it("a message sent from the web app reaches the client with the network's msgid", async () => {
    const live = await seedLive();
    const c = await attachIn(live, '#room');
    ircManager.send(live.userId, live.networkId, '#room', 'from the web');
    const echo = await c.waitFor((l) => l.includes('PRIVMSG #room :from the web'));
    const row = await stored(live, 'from the web');
    expect(String(row.msgid)).toMatch(/^m[0-9]+$/);
    expect(msgidOf(echo)).toBe(row.msgid);
  });
});
