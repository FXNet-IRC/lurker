// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A soju.im/bouncer-networks-notify client hears when a network is added,
// edited or deleted in the web app, and why one isn't connecting. Through the
// real network routes and ircManager. Dials are faked with the harness's
// upstreams, except in the `error` tests, which dial for real. See
// bouncerHarness.ts.

import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';

const ctx = setupTestDb('services-bouncer-networknotify');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let networksDb: typeof import('../db/networks.js');
let db: typeof import('../db/index.js').default;
let harness: import('../test-utils/bouncerHarness.js').Harness;
let app: Express;
let ircd: FakeIrcd;

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  networksDb = await import('../db/networks.js');
  db = (await import('../db/index.js')).default;
  const router = (await import('../routes/networks.js')).default;
  app = createTestApp({ '/api/networks': router });
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
  vi.restoreAllMocks();
});

// startNetwork stands in for a dial: a fake connection that's connecting, with
// the network's nick until it registers, as a real one has.
function fakeDials(): void {
  vi.spyOn(ircManager, 'startNetwork').mockImplementation((userId, networkId) => {
    const row = networksDb.getNetwork(networkId, userId)!;
    const upstream = new harnessMod.FakeUpstream(row.nick);
    upstream.network = row;
    ircManager.connectionsForUser(userId).set(networkId, upstream as never);
    harnessMod.emitNetworkState(userId, networkId, 'connecting');
    return upstream as never;
  });
}

const NUL = String.fromCharCode(0);
const NOTIFY_CAPS = 'sasl soju.im/bouncer-networks soju.im/bouncer-networks-notify';

// Log in over SASL and register, binding `bind` if given.
async function attach(acct: Account, caps: string, bind?: number): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  const plain = Buffer.from(['', acct.user.username, acct.password].join(NUL)).toString('base64');
  c.send(`AUTHENTICATE ${plain}`);
  await c.waitForCommand('903');
  if (bind) c.send(`BOUNCER BIND ${bind}`);
  c.send('CAP END');
  await synced(c);
  return c;
}

// A client on the network by its login name, with no caps.
async function attachPlain(acct: Account, networkName: string): Promise<Client> {
  const c = await harness.connect();
  cleanups.push(() => c.close());
  c.send(`PASS ${acct.user.username}/${networkName}:${acct.password}`);
  c.send('NICK client');
  c.send('USER client 0 * :client');
  await c.waitForCommand('001');
  return c;
}

let syncSeq = 0;
// Resolves once the client has everything the bouncer sent before this.
async function synced(c: Client): Promise<void> {
  const token = `sync${++syncSeq}`;
  c.send(`PING :${token}`);
  await c.waitFor((l) => l.includes(' PONG ') && l.endsWith(`:${token}`));
}

// The BOUNCER NETWORK lines a client got after `mark` lines.
function networkLines(c: Client, mark: number): string[] {
  return c.lines.slice(mark).filter((l) => l.includes(' BOUNCER NETWORK '));
}

async function agentFor(acct: Account) {
  return createAuthedAgent(app, acct.user.id);
}

describe('a network added in the web app', () => {
  it('reaches a -notify client whole, before the state of its first connect', async () => {
    fakeDials();
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);

    const mark = c.lines.length;
    const res = await agent
      .post('/api/networks')
      .send({ name: 'gamma net', host: 'irc.gamma.test', port: 6697, tls: true, nick: 'gam' });
    expect(res.status).toBe(201);
    await synced(c);

    const id = res.body.network.id;
    expect(networkLines(c, mark)).toEqual([
      `:lurker.bouncer BOUNCER NETWORK ${id} name=gamma\\snet;state=disconnected;host=irc.gamma.test;port=6697;tls=1;nickname=gam`,
      `:lurker.bouncer BOUNCER NETWORK ${id} state=connecting`,
    ]);
  });

  it('is not sent to a client without the notify cap', async () => {
    fakeDials();
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, 'sasl soju.im/bouncer-networks');
    const agent = await agentFor(acct);

    const mark = c.lines.length;
    const res = await agent
      .post('/api/networks')
      .send({ name: 'gamma', host: 'irc.gamma.test', port: 6697, tls: true, nick: 'gam' });
    await agent.patch(`/api/networks/${res.body.network.id}`).send({ name: 'gamma2' });
    await agent.delete(`/api/networks/${res.body.network.id}`);
    await synced(c);

    expect(networkLines(c, mark)).toEqual([]);
  });
});

describe('an edit in the web app', () => {
  it('sends only the attributes that changed', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);

    const mark = c.lines.length;
    await agent.patch(`/api/networks/${acct.network.id}`).send({ name: 'alpha two', port: 7000 });
    await synced(c);

    expect(networkLines(c, mark)).toEqual([
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} name=alpha\\stwo;port=7000`,
    ]);
  });

  it('sends nothing when no attribute changed', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);

    const mark = c.lines.length;
    await agent.patch(`/api/networks/${acct.network.id}`).send({ realname: 'Someone Else' });
    await agent.patch(`/api/networks/${acct.network.id}`).send({ name: 'alpha' });
    await synced(c);

    expect(networkLines(c, mark)).toEqual([]);
  });

  it("gives a client bound to the network the network's new name", async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attachPlain(acct, 'alpha');
    const agent = await agentFor(acct);

    await agent.patch(`/api/networks/${acct.network.id}`).send({ name: 'renamed' });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting');

    const notice = await c.waitFor((l) => l.includes('Upstream reconnecting'));
    expect(notice).toContain("to 'renamed'.");
  });
});

describe('a network deleted in the web app', () => {
  it('closes the clients bound to it, and tells the other -notify clients it is gone', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const beta = harnessMod.seedNetwork(acct.user, { networkName: 'beta' });
    const control = await attach(acct, NOTIFY_CAPS);
    const boundBeta = await attach(acct, NOTIFY_CAPS, beta.network.id);
    const boundAlpha = await attachPlain(acct, 'alpha');
    const closed = new Promise((resolve) => boundAlpha.socket.once('close', resolve));
    const agent = await agentFor(acct);

    const controlMark = control.lines.length;
    const betaMark = boundBeta.lines.length;
    const res = await agent.delete(`/api/networks/${acct.network.id}`);
    expect(res.status).toBe(200);

    await boundAlpha.waitFor((l) => l === 'ERROR :Network removed');
    await closed;
    expect(bouncerMod.attachedSessionCount(acct.user.id, acct.network.id)).toBe(0);
    await synced(control);
    await synced(boundBeta);
    const gone = `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} *`;
    expect(networkLines(control, controlMark)).toEqual([gone]);
    expect(networkLines(boundBeta, betaMark)).toEqual([gone]);
  });

  it('is never mentioned again, even by a late state change', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta' });
    const before = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);

    const mark = before.lines.length;
    await agent.delete(`/api/networks/${acct.network.id}`);
    const after = await attach(acct, NOTIFY_CAPS);
    const afterMark = after.lines.length;
    ircManager.emit('event', {
      userId: acct.user.id,
      networkId: acct.network.id,
      type: 'state',
      state: 'disconnected',
    });
    await synced(before);
    await synced(after);

    expect(networkLines(before, mark)).toEqual([
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} *`,
    ]);
    // A client that never heard of the network isn't told it's gone either.
    expect(networkLines(after, afterMark)).toEqual([]);
  });
});

describe('a network list', () => {
  it('replaces what the client was told, so a later change is measured against it', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const beta = harnessMod.seedNetwork(acct.user, { networkName: 'beta' });
    const c = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);

    // Without -notify the client isn't told beta is gone, but a list says so.
    c.send('CAP REQ :-soju.im/bouncer-networks-notify');
    await c.waitFor((l) => l.includes('ACK :-soju.im/bouncer-networks-notify'));
    await agent.delete(`/api/networks/${beta.network.id}`);
    c.send('CAP REQ :soju.im/bouncer-networks-notify');
    await c.waitFor((l) => l.endsWith('ACK :soju.im/bouncer-networks-notify'));
    c.send('BOUNCER LISTNETWORKS');
    await synced(c);

    const mark = c.lines.length;
    ircManager.emit('event', {
      userId: acct.user.id,
      networkId: beta.network.id,
      type: 'state',
      state: 'disconnected',
    });
    await synced(c);
    expect(networkLines(c, mark)).toEqual([]);
  });
});

describe('a state change', () => {
  it('reaches a client bound to the network as one notice, however often it is repeated', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attachPlain(acct, 'alpha');

    const mark = c.lines.length;
    // The state it attached in.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connected');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    // What a stopped retry adds: the same state, saying why.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: 'Not reconnecting automatically: banned by the server (G-Lined).',
    });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting');
    await synced(c);

    const notices = c.lines.slice(mark).filter((l) => l.includes('Upstream '));
    // The bare disconnect, the same state saying why it won't come back, and
    // the retry. The two bare repeats say nothing new.
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain("Upstream disconnected from 'alpha'.");
    expect(notices[1]).toContain(
      "Upstream disconnected from 'alpha': Not reconnecting automatically: banned by the server (G-Lined).",
    );
    expect(notices[2]).toContain("Upstream reconnecting to 'alpha'.");
    // Never a promise to retry: three of those five states won't.
    expect(notices.join('\n')).not.toContain('keep retrying');
  });

  // The app's link to the engine dropped while the engine kept the IRC socket
  // open. Nothing about the network changed, so the client hears nothing: the
  // caps it negotiated would otherwise be taken away and re-offered.
  it('says nothing, and takes no caps away, when only the engine link moved', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, `${NOTIFY_CAPS} away-notify`, acct.network.id);

    const mark = c.lines.length;
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting', {
      engineLink: true,
    });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connecting', { engineLink: true });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connected', { engineLink: true });
    await synced(c);

    const after = c.lines.slice(mark);
    expect(after.filter((l) => l.includes('Upstream '))).toEqual([]);
    expect(after.filter((l) => l.includes(' CAP '))).toEqual([]);
    expect(networkLines(c, mark)).toEqual([]);
  });

  // What a real drop looks like: 'socket close' says why, then 'close' says
  // the same state with nothing to add.
  it('says a drop once, and again only when the reason changes', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attachPlain(acct, 'alpha');

    const mark = c.lines.length;
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: 'Connection failed (irc.example.test:6697): ECONNRESET.',
    });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    // The same reason again is the same news.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: 'Connection failed (irc.example.test:6697): ECONNRESET.',
    });
    await synced(c);
    let notices = c.lines.slice(mark).filter((l) => l.includes('Upstream '));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('ECONNRESET');

    // The retry ladder running out says something new about the same state.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: 'Not reconnecting automatically: banned by the server (G-Lined).',
    });
    await synced(c);
    notices = c.lines.slice(mark).filter((l) => l.includes('Upstream '));
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('banned by the server (G-Lined)');
  });

  // A ban reason is the server's own words, and the notice has 512 bytes.
  it('keeps a long reason on one line', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attachPlain(acct, 'alpha');

    const mark = c.lines.length;
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: `Not reconnecting automatically: banned by the server (${'why '.repeat(200)}).`,
    });
    await synced(c);

    const notice = c.lines.slice(mark).find((l) => l.includes('Upstream '))!;
    expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(512);
    expect(notice.endsWith('…')).toBe(true);
  });

  // soju sends the same on attach (user.go:823).
  it('tells a client that attaches while the network is down why it is', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    acct.upstream.state = 'reconnecting';
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting', {
      error: 'Connection failed (irc.example.test:6697): ECONNREFUSED.',
    });
    const c = await attachPlain(acct, 'alpha');
    await synced(c);

    const notice = c.lines.find((l) => l.includes("Network 'alpha' is"));
    expect(notice).toContain('ECONNREFUSED');

    // Having been told on attach, the client isn't told again when the
    // connection repeats itself.
    const mark = c.lines.length;
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting', {
      error: 'Connection failed (irc.example.test:6697): ECONNREFUSED.',
    });
    await synced(c);
    expect(c.lines.slice(mark).filter((l) => l.includes('Upstream '))).toEqual([]);
  });

  // Attaching to a network that gave up restarts it (ZNC's shape), so the
  // reason the last attempt failed would contradict the attempt under way.
  it('leaves out a reason the attach itself has superseded', async () => {
    fakeDials();
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    acct.upstream.state = 'disconnected';
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', {
      error: 'Not reconnecting automatically: banned by the server (G-Lined).',
    });
    const c = await attachPlain(acct, 'alpha');
    await synced(c);

    const notice = c.lines.find((l) => l.includes("Network 'alpha' is"));
    expect(notice).toBeDefined();
    expect(notice).not.toContain('Not reconnecting automatically');
  });

  it('is sent once, however often the connection repeats it', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);

    const mark = c.lines.length;
    // IrcConnection publishes 'disconnected' from both 'socket close' and 'close'.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connecting');
    await synced(c);

    expect(networkLines(c, mark)).toEqual([
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} state=disconnected`,
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} state=connecting`,
    ]);
  });
});

// The accounts ircManager holds a connection error for.
function accountsWithErrors(): Map<number, unknown> {
  return (ircManager as unknown as { connectionErrors: Map<number, unknown> }).connectionErrors;
}

describe('error', () => {
  it('comes from the state event that carries it, and goes with a connect', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);
    const why = 'Connection failed (irc.example.test:6697): ETIMEDOUT: connect ETIMEDOUT';

    const mark = c.lines.length;
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected', { error: why });
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'reconnecting');
    expect(ircManager.connectionError(acct.user.id, acct.network.id)).toBe(why);
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connected');
    await synced(c);

    expect(networkLines(c, mark)).toEqual([
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} state=disconnected;error=Connection\\sfailed\\s(irc.example.test:6697):\\sETIMEDOUT:\\sconnect\\sETIMEDOUT`,
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} state=connecting`,
      `:lurker.bouncer BOUNCER NETWORK ${acct.network.id} state=connected;error=`,
    ]);
    expect(ircManager.connectionError(acct.user.id, acct.network.id)).toBeNull();
    // Nothing is left behind for an account whose errors have all cleared.
    expect(accountsWithErrors().has(acct.user.id)).toBe(false);
  });
});

// A port nothing listens on.
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// The attribute list a client was sent for one network, from its list or a
// notification: the last line naming it.
function lastAttrs(c: Client, networkId: number): string {
  const prefix = `BOUNCER NETWORK ${networkId} `;
  const line = c.lines.filter((l) => l.includes(prefix)).at(-1) ?? '';
  return line.slice(line.indexOf(prefix) + prefix.length);
}

describe('error, on real connections', () => {
  it('says why a network is not connecting, and clears it once it connects', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const c = await attach(acct, NOTIFY_CAPS);
    const agent = await agentFor(acct);
    const port = await closedPort();

    const res = await agent
      .post('/api/networks')
      .send({ name: 'down', host: '127.0.0.1', port, tls: false, nick: 'downnick' });
    const id = res.body.network.id;
    cleanups.push(() => ircManager.disposeNetwork(acct.user.id, id));
    const why = `error=Connection\\sfailed\\s(127.0.0.1:${port}):\\sECONNREFUSED`;
    await c.waitFor((l) => l.includes(`BOUNCER NETWORK ${id} `) && l.includes(why), 5000);

    // It stays while Lurker retries, and a client that attaches now is told.
    const later = await attach(acct, NOTIFY_CAPS);
    expect(lastAttrs(later, id)).toContain(why);

    await agent.patch(`/api/networks/${id}`).send({ port: ircd.port });
    ircManager.restartNetwork(acct.user.id, id);
    const connected = `:lurker.bouncer BOUNCER NETWORK ${id} state=connected;error=`;
    await c.waitFor((l) => l === connected, 5000);
    await later.waitFor((l) => l === connected, 5000);
    expect(ircManager.connectionError(acct.user.id, id)).toBeNull();
  });

  it('keeps why a connect was refused over settings after the connection is dropped', async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const agent = await agentFor(acct);
    const network = networksDb.createNetwork(acct.user.id, {
      name: 'halfcert',
      host: '127.0.0.1',
      port: ircd.port,
      tls: true,
      nick: 'halfnick',
      autoconnect: false,
    } as Parameters<typeof networksDb.createNetwork>[1])!;
    // Half a certificate: the dial refuses before it opens a socket.
    db.prepare('UPDATE networks SET client_cert = ? WHERE id = ?').run('not-a-cert', network.id);
    const c = await attach(acct, NOTIFY_CAPS);

    const mark = c.lines.length;
    await agent.post(`/api/networks/${network.id}/connect`);
    await synced(c);

    const why = 'error=Not\\sconnecting:\\sthis\\snetwork\\shas\\shalf\\sa\\sclient\\scertificate';
    const lines = networkLines(c, mark);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`BOUNCER NETWORK ${network.id} ${why}`);
    expect(ircManager.getConnection(acct.user.id, network.id)).toBeNull();

    const later = await attach(acct, NOTIFY_CAPS);
    expect(lastAttrs(later, network.id)).toContain(why);

    await agent.delete(`/api/networks/${network.id}`);
    expect(ircManager.connectionError(acct.user.id, network.id)).toBeNull();
    expect(accountsWithErrors().has(acct.user.id)).toBe(false);
  });

  it("forgets a deleted account's errors", async () => {
    const acct = harnessMod.seedAccount({ networkName: 'alpha' });
    const agent = await agentFor(acct);
    const network = networksDb.createNetwork(acct.user.id, {
      name: 'halfcert',
      host: '127.0.0.1',
      port: ircd.port,
      tls: true,
      nick: 'halfnick',
      autoconnect: false,
    } as Parameters<typeof networksDb.createNetwork>[1])!;
    db.prepare('UPDATE networks SET client_cert = ? WHERE id = ?').run('not-a-cert', network.id);
    await agent.post(`/api/networks/${network.id}/connect`);
    expect(ircManager.connectionError(acct.user.id, network.id)).not.toBeNull();

    ircManager.disposeUser(acct.user.id, 'user deleted');
    expect(ircManager.connectionError(acct.user.id, network.id)).toBeNull();
  });
});
