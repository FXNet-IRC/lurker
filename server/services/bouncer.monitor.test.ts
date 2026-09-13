// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for MONITOR through the bouncer. Each client keeps its
// own list on the network's single list, and the network's answers reach only
// the clients watching those nicks. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-monitor');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  harness = await harnessMod.startHarness();
});

afterAll(() => {
  harness.stop();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;

// A capless client on a single-network account, logged in with PASS.
async function attach(acct: Account): Promise<Client> {
  const c = await harness.connect();
  c.send(`PASS ${acct.user.username}:${acct.password}`);
  c.send('NICK client');
  c.send('USER client 0 * :client');
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

// The params of each line with this numeric.
function paramsOf(lines: string[], numeric: string): string[][] {
  return lines
    .filter((l) => harnessMod.commandOf(l) === numeric)
    .map((l) => bouncerMod.parseClientLine(l)!.params);
}

// The MONITOR +, - and C lines sent to the network. MONITOR S is counted apart.
function monitorSent(acct: Account): string[] {
  return acct.upstream.rawSent.filter((l) => l.startsWith('MONITOR') && l !== 'MONITOR S');
}

function statusRequests(acct: Account): number {
  return acct.upstream.rawSent.filter((l) => l === 'MONITOR S').length;
}

describe('MONITOR per client', () => {
  it("puts a client's nicks on the network's list and relays the answers", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon1' });
    const c = await attach(acct);
    c.send('MONITOR + Alice,bob');
    await settle(c);
    expect(monitorSent(acct)).toEqual(['MONITOR + Alice,bob']);

    acct.upstream.pushUpstream(':irc.example.test 730 mon1 :Alice!a@example.test');
    acct.upstream.pushUpstream(':irc.example.test 731 mon1 :bob');
    await settle(c);
    expect(paramsOf(c.lines, '730')).toEqual([['mon1', 'Alice!a@example.test']]);
    expect(paramsOf(c.lines, '731')).toEqual([['mon1', 'bob']]);
    c.close();
  });

  it('sends each client only the nicks it watches', async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon2' });
    const c1 = await attach(acct);
    const c2 = await attach(acct);
    c1.send('MONITOR + alice');
    await settle(c1);
    c2.send('MONITOR + bob');
    await settle(c2);

    // One answer naming both, plus a nick no client watches (one of Lurker's).
    acct.upstream.pushUpstream(':irc.example.test 730 mon2 :alice,bob,dmpeer');
    await settle(c1);
    await settle(c2);
    expect(paramsOf(c1.lines, '730')).toEqual([['mon2', 'alice']]);
    expect(paramsOf(c2.lines, '730')).toEqual([['mon2', 'bob']]);
    c1.close();
    c2.close();
  });

  it('shares one watch between clients and answers the second itself', async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon3' });
    const c1 = await attach(acct);
    c1.send('MONITOR + carol');
    await settle(c1);
    acct.upstream.pushUpstream(':irc.example.test 730 mon3 :carol!c@example.test');
    await settle(c1);

    // The network already watches carol and won't answer for her again.
    const c2 = await attach(acct);
    c2.send('MONITOR + Carol');
    await settle(c2);
    expect(paramsOf(c2.lines, '730')).toEqual([['mon3', 'Carol']]);
    expect(monitorSent(acct)).toEqual(['MONITOR + carol']);

    // She stays on the list while either client wants her.
    c1.send('MONITOR - carol');
    await settle(c1);
    expect(monitorSent(acct)).toEqual(['MONITOR + carol']);
    c2.close();
    await vi.waitFor(() =>
      expect(monitorSent(acct)).toEqual(['MONITOR + carol', 'MONITOR - carol']),
    );
    c1.close();
  });

  it("clears only the client's own nicks on MONITOR C", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon4' });
    const c1 = await attach(acct);
    const c2 = await attach(acct);
    c1.send('MONITOR + dave,erin');
    await settle(c1);
    c2.send('MONITOR + erin');
    await settle(c2);
    c1.send('MONITOR C');
    await settle(c1);
    expect(monitorSent(acct)).toEqual(['MONITOR + dave,erin', 'MONITOR - dave']);
    c1.close();
    c2.close();
  });

  it("lists and reports only the client's own nicks", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon5' });
    const c1 = await attach(acct);
    const c2 = await attach(acct);
    c1.send('MONITOR + frank,grace');
    await settle(c1);
    c2.send('MONITOR + heidi');
    await settle(c2);
    acct.upstream.pushUpstream(':irc.example.test 730 mon5 :frank,heidi');
    await settle(c1);

    const from = c1.lines.length;
    c1.send('MONITOR L');
    c1.send('MONITOR S');
    await settle(c1);
    const lines = c1.lines.slice(from);
    expect(paramsOf(lines, '732')).toEqual([
      ['mon5', 'frank'],
      ['mon5', 'grace'],
    ]);
    expect(paramsOf(lines, '733')).toEqual([['mon5', 'End of MONITOR list']]);
    // grace has no answer from the network yet, so she counts as offline.
    expect(paramsOf(lines, '730')).toEqual([['mon5', 'frank']]);
    expect(paramsOf(lines, '731')).toEqual([['mon5', 'grace']]);
    c1.close();
    c2.close();
  });

  it("answers 734 for the nicks past the network's limit", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon6' });
    acct.upstream.monitorLimit = 2;
    const c = await attach(acct);
    c.send('MONITOR + ivan,judy,mallory');
    await settle(c);
    expect(monitorSent(acct)).toEqual(['MONITOR + ivan,judy']);
    expect(paramsOf(c.lines, '734')).toEqual([['mon6', '2', 'mallory', 'Monitor list is full']]);

    c.send('MONITOR L');
    await settle(c);
    expect(paramsOf(c.lines, '732')).toEqual([
      ['mon6', 'ivan'],
      ['mon6', 'judy'],
    ]);
    c.close();
  });

  it("passes the network's 734 to the client that named the nick, which drops it", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon7' });
    const c1 = await attach(acct);
    const c2 = await attach(acct);
    c1.send('MONITOR + niaj');
    await settle(c1);
    acct.upstream.pushUpstream(':irc.example.test 734 mon7 1 niaj :Monitor list is full.');
    await settle(c1);
    await settle(c2);
    expect(paramsOf(c1.lines, '734')).toEqual([['mon7', '1', 'niaj', 'Monitor list is full.']]);
    expect(paramsOf(c2.lines, '734')).toEqual([]);

    c1.send('MONITOR L');
    await settle(c1);
    expect(paramsOf(c1.lines, '732')).toEqual([]);
    c1.close();
    c2.close();
  });

  it('drops list replies from the network, which no client asked for', async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon8' });
    const c = await attach(acct);
    acct.upstream.pushUpstream(':irc.example.test 732 mon8 :olivia');
    acct.upstream.pushUpstream(':irc.example.test 733 mon8 :End of MONITOR list');
    await settle(c);
    expect(paramsOf(c.lines, '732')).toEqual([]);
    expect(paramsOf(c.lines, '733')).toEqual([]);
    c.close();
  });

  it("refuses MONITOR when the network doesn't support it", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon9' });
    acct.upstream.useMonitor = false;
    const c = await attach(acct);
    c.send('MONITOR + peggy');
    await settle(c);
    expect(paramsOf(c.lines, '421')).toEqual([['mon9', 'MONITOR', 'Unknown command']]);
    expect(monitorSent(acct)).toEqual([]);
    c.close();
  });

  it("keeps a watch sent before the network's ISUPPORT is complete", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon10' });
    const c = await attach(acct);
    // Registered, but the 005 naming MONITOR hasn't arrived yet.
    acct.upstream.useMonitor = false;
    acct.upstream.isupportComplete = false;
    c.send('MONITOR + sybil');
    await settle(c);
    expect(paramsOf(c.lines, '421')).toEqual([]);

    // The seed that follows ISUPPORT puts the nick on the list.
    acct.upstream.useMonitor = true;
    acct.upstream.isupportComplete = true;
    acct.upstream.syncMonitor();
    expect(monitorSent(acct)).toEqual(['MONITOR + sybil']);
    c.close();
  });

  it("asks for the state of a client's nicks the network hasn't answered for, once a read", async () => {
    const acct = harnessMod.seedAccount({ nick: 'mon11' });
    const c1 = await attach(acct);
    // Two adds in one read: gamja sends a MONITOR + per nick.
    c1.socket.write('MONITOR + quinn\r\nMONITOR + rupert\r\n');
    await settle(c1);
    expect(statusRequests(acct)).toBe(1);

    // Another client adds a nick the network hasn't answered for yet.
    const c2 = await attach(acct);
    c2.send('MONITOR + quinn');
    await settle(c2);
    expect(statusRequests(acct)).toBe(2);

    // Once it has answered, an add asks for nothing.
    acct.upstream.pushUpstream(':irc.example.test 730 mon11 :quinn,rupert');
    await settle(c1);
    const c3 = await attach(acct);
    c3.send('MONITOR + rupert');
    await settle(c3);
    expect(statusRequests(acct)).toBe(2);
    c1.close();
    c2.close();
    c3.close();
  });
});
