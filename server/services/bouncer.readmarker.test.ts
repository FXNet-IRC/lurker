// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for IRCv3 draft/read-marker. MARKREAD reads and moves the
// account's read pointer, the one the web and iOS apps share. See
// bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

// The apps' side of a move made over IRC. No WebSocket is open in these tests,
// so the call itself is what gets checked.
vi.mock('./wsHub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wsHub.js')>()),
  broadcastReadState: vi.fn<typeof import('./wsHub.js').broadcastReadState>(),
}));

const ctx = setupTestDb('services-bouncer-readmarker');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let ircManager: typeof import('./ircManager.js').default;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let bufferReads: typeof import('../db/bufferReads.js');
let wsHub: typeof import('./wsHub.js');
let db: typeof import('../db/index.js').default;
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ircManager = (await import('./ircManager.js')).default;
  ({ insertMessage } = await import('../db/messages.js'));
  bufferReads = await import('../db/bufferReads.js');
  wsHub = await import('./wsHub.js');
  db = (await import('../db/index.js')).default;
  harness = await harnessMod.startHarness();
});

afterAll(() => {
  harness.stop();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
  vi.mocked(wsHub.broadcastReadState).mockClear();
});

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;

const NUL = String.fromCharCode(0);
function saslPlain(authcid: string, passwd: string): string {
  return Buffer.from(['', authcid, passwd].join(NUL), 'utf8').toString('base64');
}

const MARKER_CAPS = 'sasl server-time draft/read-marker';

// Log in over SASL with `caps` and wait for the end of the welcome.
async function attach(acct: Account, caps = MARKER_CAPS): Promise<Client> {
  const c = await harness.connect();
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
  return c;
}

// The bouncer handles a client's lines in order, so the PONG comes after
// everything the earlier lines caused.
let pings = 0;
async function settle(c: Client): Promise<void> {
  const token = `settle${++pings}`;
  c.send(`PING ${token}`);
  await c.waitFor((l) => harnessMod.commandOf(l) === 'PONG' && l.endsWith(`:${token}`));
}

// 06:00:01, 06:00:02, … on one day.
function at(second: number): string {
  return `2023-05-23T06:00:${String(second).padStart(2, '0')}.000Z`;
}

// `n` messages from bob in `target`, a second apart from at(1). Returns their ids.
function seedMessages(acct: Account, target: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    const { id } = insertMessage({
      networkId: acct.network.id,
      target,
      time: at(i),
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: `msg${i}`,
      self: false,
    });
    ids.push(Number(id));
  }
  return ids;
}

function markreads(c: Client): string[] {
  return c.lines.filter((l) => harnessMod.commandOf(l) === 'MARKREAD');
}

function fails(c: Client): string[] {
  return c.lines.filter((l) => harnessMod.commandOf(l) === 'FAIL');
}

describe('the cap', () => {
  it('is offered', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls.split(' ')).toContain('draft/read-marker');
  });
});

describe('MARKREAD in the join burst', () => {
  it('comes after the JOIN and before NAMES, with the stored time or *', async () => {
    const acct = harnessMod.seedAccount({ nick: 'burst' });
    acct.upstream.addChannel('#read', { topic: 'hello', members: ['burst', 'bob'] });
    acct.upstream.addChannel('#unread', { members: ['burst'] });
    const ids = seedMessages(acct, '#read', 3);
    bufferReads.setReadState(acct.user.id, acct.network.id, '#read', ids[1]);
    const c = await attach(acct);
    await settle(c);
    const join = c.lines.findIndex(
      (l) => harnessMod.commandOf(l) === 'JOIN' && l.endsWith(' #read'),
    );
    const marker = c.lines.indexOf(`:lurker.bouncer MARKREAD #read timestamp=${at(2)}`);
    const names = c.lines.findIndex(
      (l) => harnessMod.commandOf(l) === '353' && l.includes(' #read '),
    );
    expect(join).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(join);
    expect(names).toBeGreaterThan(marker);
    expect(markreads(c)).toContain(':lurker.bouncer MARKREAD #unread *');
  });

  it('is left out for a client without the cap', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nocap' });
    acct.upstream.addChannel('#quiet', { members: ['nocap'] });
    const c = await attach(acct, 'sasl server-time');
    await settle(c);
    expect(c.lines.some((l) => harnessMod.commandOf(l) === 'JOIN')).toBe(true);
    expect(markreads(c)).toEqual([]);
  });
});

describe('MARKREAD after a live JOIN', () => {
  it("follows our own JOIN, and not anyone else's", async () => {
    const acct = harnessMod.seedAccount({ nick: 'joiner' });
    const c = await attach(acct);
    // With the CRLF irc-framework leaves on a raw line, as the relay really gets it.
    acct.upstream.pushUpstream(':bob!u@h JOIN #live\r\n');
    acct.upstream.pushUpstream(':joiner!u@h JOIN #live\r\n');
    await settle(c);
    const join = c.lines.findIndex((l) => l.endsWith(':joiner!u@h JOIN #live'));
    expect(join).toBeGreaterThanOrEqual(0);
    expect(c.lines[join + 1]).toBe(':lurker.bouncer MARKREAD #live *');
    expect(markreads(c)).toHaveLength(1);
  });
});

describe('MARKREAD with a time', () => {
  it('moves the pointer to the newest message at or before it, and tells every capable client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'setter' });
    const ids = seedMessages(acct, '#set', 3);
    const a = await attach(acct);
    const b = await attach(acct);
    const capless = await attach(acct, 'sasl server-time');
    a.send('MARKREAD #set timestamp=2023-05-23T06:00:02.500Z');
    await settle(a);
    await settle(b);
    await settle(capless);
    const moved = [`:lurker.bouncer MARKREAD #set timestamp=${at(2)}`];
    expect(markreads(a)).toEqual(moved);
    expect(markreads(b)).toEqual(moved);
    expect(markreads(capless)).toEqual([]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#set')).toBe(ids[1]);
  });

  it('tells the web and iOS apps, under the buffer name they know', async () => {
    const acct = harnessMod.seedAccount({ nick: 'apps' });
    const ids = seedMessages(acct, '#Apps', 2);
    const c = await attach(acct);
    c.send(`MARKREAD #apps timestamp=${at(2)}`);
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #apps timestamp=${at(2)}`]);
    expect(wsHub.broadcastReadState).toHaveBeenCalledWith(
      acct.user.id,
      acct.network.id,
      '#Apps',
      ids[1],
      expect.any(Number),
    );
  });

  it('lands on the newest message when the time is past it', async () => {
    const acct = harnessMod.seedAccount({ nick: 'tail' });
    const ids = seedMessages(acct, '#tail', 3);
    const c = await attach(acct);
    c.send('MARKREAD #tail timestamp=2023-05-23T07:00:00.000Z');
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #tail timestamp=${at(3)}`]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#tail')).toBe(ids[2]);
  });

  it('takes a time without a fraction, as HexDroid sends it', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nofrac' });
    const ids = seedMessages(acct, '#nofrac', 3);
    const c = await attach(acct);
    c.send('MARKREAD #nofrac timestamp=2023-05-23T06:00:02Z');
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #nofrac timestamp=${at(2)}`]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#nofrac')).toBe(ids[1]);
  });

  it('answers only the sender, with the stored marker, when nothing moves', async () => {
    const acct = harnessMod.seedAccount({ nick: 'stale' });
    const ids = seedMessages(acct, '#stale', 3);
    bufferReads.setReadState(acct.user.id, acct.network.id, '#stale', ids[2]);
    const a = await attach(acct);
    const b = await attach(acct);
    a.send(`MARKREAD #stale timestamp=${at(1)}`);
    await settle(a);
    await settle(b);
    expect(markreads(a)).toEqual([`:lurker.bouncer MARKREAD #stale timestamp=${at(3)}`]);
    expect(markreads(b)).toEqual([]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#stale')).toBe(ids[2]);
    expect(wsHub.broadcastReadState).not.toHaveBeenCalled();
  });

  it('answers * when no message is that old, or the target has no buffer', async () => {
    const acct = harnessMod.seedAccount({ nick: 'early' });
    seedMessages(acct, '#early', 2);
    const c = await attach(acct);
    c.send('MARKREAD #early timestamp=2023-05-23T05:00:00.000Z');
    c.send(`MARKREAD nobody timestamp=${at(1)}`);
    await settle(c);
    expect(markreads(c)).toEqual([
      ':lurker.bouncer MARKREAD #early *',
      ':lurker.bouncer MARKREAD nobody *',
    ]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#early')).toBe(0);
  });

  it('works while the network is down', async () => {
    const acct = harnessMod.seedAccount({ nick: 'down' });
    const ids = seedMessages(acct, '#down', 2);
    const c = await attach(acct);
    acct.upstream.state = 'disconnected';
    c.send(`MARKREAD #down timestamp=${at(1)}`);
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #down timestamp=${at(1)}`]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#down')).toBe(ids[0]);
  });
});

describe('MARKREAD without a time', () => {
  it('returns the stored marker for a channel and a DM, and * for anything else', async () => {
    const acct = harnessMod.seedAccount({ nick: 'getter' });
    const channel = seedMessages(acct, '#got', 2);
    const dm = seedMessages(acct, 'bob', 2);
    bufferReads.setReadState(acct.user.id, acct.network.id, '#got', channel[0]);
    bufferReads.setReadState(acct.user.id, acct.network.id, 'bob', dm[1]);
    const c = await attach(acct);
    c.send('MARKREAD #got');
    c.send('MARKREAD Bob');
    c.send('MARKREAD #never');
    await settle(c);
    expect(markreads(c)).toEqual([
      `:lurker.bouncer MARKREAD #got timestamp=${at(1)}`,
      `:lurker.bouncer MARKREAD Bob timestamp=${at(2)}`,
      ':lurker.bouncer MARKREAD #never *',
    ]);
  });

  it("falls back to the message below the pointer when the pointer's row is gone", async () => {
    const acct = harnessMod.seedAccount({ nick: 'pruned' });
    const ids = seedMessages(acct, '#pruned', 3);
    bufferReads.setReadState(acct.user.id, acct.network.id, '#pruned', ids[2]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(ids[2]);
    const c = await attach(acct);
    c.send('MARKREAD #pruned');
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #pruned timestamp=${at(2)}`]);
  });
});

describe('MARKREAD errors', () => {
  it('needs a target', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bare' });
    const c = await attach(acct);
    c.send('MARKREAD');
    await settle(c);
    expect(fails(c)).toEqual([
      ':lurker.bouncer FAIL MARKREAD NEED_MORE_PARAMS :Missing parameters',
    ]);
  });

  it('refuses anything but a timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'badtime' });
    seedMessages(acct, '#bad', 1);
    const c = await attach(acct);
    c.send('MARKREAD #bad *');
    c.send('MARKREAD #bad timestamp=yesterday');
    // A date that doesn't exist, which Date.parse would read as March 2.
    c.send('MARKREAD #bad timestamp=2023-02-30T06:00:00Z');
    await settle(c);
    expect(fails(c)).toEqual([
      ':lurker.bouncer FAIL MARKREAD INVALID_PARAMS * :Invalid timestamp',
      ':lurker.bouncer FAIL MARKREAD INVALID_PARAMS timestamp=yesterday :Invalid timestamp',
      ':lurker.bouncer FAIL MARKREAD INVALID_PARAMS timestamp=2023-02-30T06:00:00Z :Invalid timestamp',
    ]);
    expect(bufferReads.getReadState(acct.user.id, acct.network.id, '#bad')).toBe(0);
  });

  it('refuses a control connection, which has no network', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ctl' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ctlb' });
    const c = await attach(acct, 'sasl soju.im/bouncer-networks draft/read-marker');
    c.send(`MARKREAD #chan timestamp=${at(1)}`);
    await settle(c);
    expect(fails(c)).toEqual([
      ':lurker.bouncer FAIL MARKREAD INTERNAL_ERROR #chan :Cannot set read markers on the bouncer connection',
    ]);
  });
});

describe('a move made in the apps', () => {
  it('reaches every capable client on the network', async () => {
    const acct = harnessMod.seedAccount({ nick: 'fromapps' });
    const ids = seedMessages(acct, '#web', 3);
    const c = await attach(acct);
    ircManager.markRead(acct.user.id, acct.network.id, '#web', ids[1]);
    await settle(c);
    expect(markreads(c)).toEqual([`:lurker.bouncer MARKREAD #web timestamp=${at(2)}`]);
  });

  it("sends nothing when the pointer doesn't move, or for the server buffer", async () => {
    const acct = harnessMod.seedAccount({ nick: 'still' });
    const ids = seedMessages(acct, '#still', 2);
    const serverTarget = `:server:${acct.network.id}`;
    const server = seedMessages(acct, serverTarget, 1);
    bufferReads.setReadState(acct.user.id, acct.network.id, '#still', ids[1]);
    const c = await attach(acct);
    expect(ircManager.markRead(acct.user.id, acct.network.id, '#still', ids[0])).toBe(ids[1]);
    // This one does move, so only the server buffer's carve-out keeps it off the wire.
    const serverMove = ircManager.markRead(acct.user.id, acct.network.id, serverTarget, server[0]);
    expect(serverMove).toBe(server[0]);
    await settle(c);
    expect(markreads(c)).toEqual([]);
  });
});

describe('a relayed line without server-time', () => {
  it('carries the time the connection gave the line', async () => {
    const acct = harnessMod.seedAccount({ nick: 'stamp' });
    const c = await attach(acct);
    acct.upstream.lineArrivedAt = new Date('2021-01-01T00:00:00.123Z');
    acct.upstream.pushUpstream(':bob!u@h PRIVMSG #stamp :untimed');
    acct.upstream.lineArrivedAt = null;
    await settle(c);
    expect(c.lines.find((l) => l.endsWith('PRIVMSG #stamp :untimed'))).toBe(
      '@time=2021-01-01T00:00:00.123Z :bob!u@h PRIVMSG #stamp :untimed',
    );
  });
});
