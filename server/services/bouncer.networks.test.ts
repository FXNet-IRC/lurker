// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for the soju.im/bouncer-networks control surface:
// control (unbound) mode, BOUNCER LISTNETWORKS / BIND, BOUNCER_NETID, and the
// -notify state-change pushes. See test-utils/bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-networks');

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

const NUL = String.fromCharCode(0);
function saslPlain(authcid: string, passwd: string): string {
  return Buffer.from(['', authcid, passwd].join(NUL), 'utf8').toString('base64');
}

// Drive CAP + SASL to the point of registration, requesting the given caps.
// Leaves the client at CAP-END-ready (caller sends CAP END + BOUNCER as needed).
type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;
async function negotiate(
  c: Client,
  acct: { user: { username: string }; password: string },
  caps: string,
): Promise<void> {
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
}

describe('control (unbound) mode', () => {
  it('registers a bouncer-networks client with no network as a control connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ctl1' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ctl1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    const welcome = await c.waitForCommand('005');
    // Control connections must NOT advertise BOUNCER_NETID (that's the signal).
    expect(welcome).not.toContain('BOUNCER_NETID');
    expect(harnessMod.attachedFor(acct)).toBe(0); // not bound to network 1
  });

  it('refuses channel/user traffic on a control connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ctl2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('PRIVMSG #chan :hi');
    const notice = await c.waitForCommand('NOTICE');
    expect(notice.toLowerCase()).toContain('bind a network');
  });
});

describe('BOUNCER LISTNETWORKS', () => {
  it('returns a batch of BOUNCER NETWORK lines when the client negotiated batch', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ls1', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'ls1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl batch soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER LISTNETWORKS');
    const open = await c.waitForCommand('BATCH');
    const ref = open.split('BATCH +')[1].split(' ')[0];
    expect(open).toContain('soju.im/bouncer-networks');
    const net1 = await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=alpha'));
    expect(net1).toContain(`@batch=${ref}`);
    expect(net1).toMatch(/BOUNCER NETWORK \d+ /);
    expect(net1).toContain('state=connected'); // fake upstream is "connected"
    await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=beta'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });

  it('sends unwrapped, untagged BOUNCER NETWORK lines without the batch cap', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ls2', networkName: 'solo' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks'); // no batch cap
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER LISTNETWORKS');
    const line = await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=solo'));
    // No message tag, and no surrounding BATCH command.
    expect(line).not.toContain('@batch=');
    expect(line.startsWith(':')).toBe(true);
    expect(c.lines.some((l) => harnessMod.commandOf(l) === 'BATCH')).toBe(false);
  });

  it('refuses BOUNCER without the bouncer-networks cap', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ls3', networkName: 'onlynet' });
    const c = await harness.connect();
    // Single network + no cap → auto-binds; then BOUNCER should be refused.
    await negotiate(c, acct, 'sasl');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER LISTNETWORKS');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('UNKNOWN_COMMAND');
    c.close();
  });
});

describe('BOUNCER BIND', () => {
  it('binds a network by id and advertises BOUNCER_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind1', networkName: 'primary' });
    const second = harnessMod.seedNetwork(acct.user, { networkName: 'secondary', nick: 'bind1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send(`BOUNCER BIND ${second.network.id}`);
    c.send('CAP END');
    const welcome = await c.waitFor((l) => l.includes('005') && l.includes('BOUNCER_NETID'));
    expect(welcome).toContain(`BOUNCER_NETID=${second.network.id}`);
    expect(bouncerMod.attachedSessionCount(acct.user.id, second.network.id)).toBe(1);
  });

  it('rejects a non-numeric BIND with FAIL INVALID_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('BOUNCER BIND notanumber');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_NETID');
    c.close();
  });

  it('rejects BIND to an unknown id at CAP END with FAIL INVALID_NETID', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind3' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('BOUNCER BIND 999999');
    c.send('CAP END');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_NETID');
    expect(fail).toContain('999999');
  });

  it('rejects BOUNCER BIND after registration with REGISTRATION_IS_COMPLETED', async () => {
    const acct = harnessMod.seedAccount({ nick: 'bind4' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER BIND 1');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('REGISTRATION_IS_COMPLETED');
    c.close();
  });
});

describe('bouncer-networks-notify', () => {
  it('sends an initial batch dump then bare state-change pushes', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy1', networkName: 'gamma' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks soju.im/bouncer-networks-notify');
    c.send('CAP END');
    // Initial dump is a batch (arrives during/after the welcome burst).
    await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=gamma'));

    // A later state change is an UNbatched BOUNCER NETWORK line.
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    const push = await c.waitFor(
      (l) => l.includes('BOUNCER NETWORK') && l.includes('state=disconnected'),
    );
    expect(push).not.toContain('@batch=');
    expect(push).toContain(`BOUNCER NETWORK ${acct.network.id}`);
  });

  it('pushes live state changes to a BOUND -notify client too', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy3', networkName: 'delta' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks soju.im/bouncer-networks-notify');
    c.send(`BOUNCER BIND ${acct.network.id}`);
    c.send('CAP END');
    await c.waitFor((l) => l.includes('BOUNCER_NETID'));
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    const push = await c.waitFor(
      (l) => l.includes('BOUNCER NETWORK') && l.includes('state=disconnected'),
    );
    expect(push).not.toContain('@batch=');
  });

  it('reports a mid-connect network as state=connecting, not disconnected', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy4', networkName: 'epsilon' });
    acct.upstream.state = 'connecting';
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('BOUNCER LISTNETWORKS');
    const line = await c.waitFor(
      (l) => l.includes('BOUNCER NETWORK') && l.includes('name=epsilon'),
    );
    expect(line).toContain('state=connecting');
  });

  it('does not push state changes to a client without the notify cap', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nfy2' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    await c.waitForCommand('422');
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'disconnected');
    // Give the event a tick; assert no BOUNCER NETWORK push arrived.
    await new Promise((r) => setTimeout(r, 50));
    expect(c.lines.some((l) => l.includes('BOUNCER NETWORK'))).toBe(false);
    c.close();
  });
});

// A login that names no network registers as a control connection instead of
// failing, matching soju's register() (which never rejects a missing network
// name). Goguma is why: its first-run registration negotiates no caps beyond
// sasl and carries no selector, so a 464 here left it unable to onboard at all.
describe('selector-less registration (soju parity)', () => {
  it('registers a capless client with several networks as a control connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl1', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'sl1b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl'); // no soju.im/bouncer-networks
    c.send('CAP END');
    const welcome = await c.waitForCommand('005');
    expect(welcome).not.toContain('BOUNCER_NETID');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('names the available networks in a NOTICE when the client cannot discover them', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl2', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'sl2b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl');
    c.send('CAP END');
    const notice = await c.waitForCommand('NOTICE');
    expect(notice).toContain(`${acct.user.username}/<network>`);
    expect(notice).toContain('alpha');
    expect(notice).toContain('beta');
  });

  it('stays quiet for a bouncer-networks client, which discovers them itself', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl3', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'sl3b' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
    c.send('CAP END');
    // The notice precedes 422 in the burst, so seeing 422 is a sufficient
    // barrier for asserting its absence — no arrival race here.
    await c.waitForCommand('422');
    expect(c.lines.some((l) => harnessMod.commandOf(l) === 'NOTICE')).toBe(false);
  });

  it('stays quiet for a -notify-only client, which still reads BOUNCER NETWORK', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl6', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'sl6b' });
    const c = await harness.connect();
    // Requesting -notify without the base cap is a client error, but the advice
    // would flatly contradict the network dump that follows it.
    await negotiate(c, acct, 'sasl soju.im/bouncer-networks-notify');
    c.send('CAP END');
    await c.waitForCommand('422');
    expect(c.lines.some((l) => harnessMod.commandOf(l) === 'NOTICE')).toBe(false);
    await c.waitFor((l) => l.includes('BOUNCER NETWORK') && l.includes('name=alpha'));
  });

  it('keeps the advice under the wire cap when the account has many networks', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl7', networkName: 'a-long-network-name-00' });
    for (let i = 1; i < 25; i++) {
      harnessMod.seedNetwork(acct.user, {
        networkName: `a-long-network-name-${String(i).padStart(2, '0')}`,
        nick: `sl7n${i}`,
      });
    }
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl');
    c.send('CAP END');
    const notice = await c.waitForCommand('NOTICE');
    // Names are unbounded TEXT, so a bare join would run past 512 bytes and the
    // client would truncate or drop the very advice it needs.
    expect(Buffer.byteLength(notice + '\r\n')).toBeLessThanOrEqual(512);
    expect(notice).toContain('a-long-network-name-00');
    expect(notice).toMatch(/\+\d+ more$/);
  });

  it('still auto-binds the only network for a capless client (ZNC floor)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl4', networkName: 'solo' });
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl');
    c.send('CAP END');
    await c.waitForCommand('422');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });

  it('registers an account with no networks and says why it is empty', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sl5' });
    harnessMod.dropNetworks(acct.user);
    const c = await harness.connect();
    await negotiate(c, acct, 'sasl'); // capless: this pairing used to 464
    c.send('CAP END');
    const notice = await c.waitForCommand('NOTICE');
    expect(notice).toContain('No IRC networks configured yet');
    await c.waitForCommand('422');
  });

  it("registers Goguma's pipelined first-run burst, which waits for nothing", async () => {
    const acct = harnessMod.seedAccount({ nick: 'gog', networkName: 'alpha' });
    harnessMod.seedNetwork(acct.user, { networkName: 'beta', nick: 'gogb' });
    const c = await harness.connect();
    // Goguma sends registration in one shot without reading CAP LS first, so it
    // requests only sasl and its AUTHENTICATE precedes our `AUTHENTICATE +`.
    c.send('CAP LS 302');
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    c.send('AUTHENTICATE PLAIN');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    c.send('CAP END');
    await c.waitForCommand('903');
    await c.waitForCommand('001');
    await c.waitForCommand('422');
    expect(c.lines.some((l) => harnessMod.commandOf(l) === '464')).toBe(false);
    expect(harnessMod.attachedFor(acct)).toBe(0); // control mode, not a blind bind
  });
});

// soju.im/FILEHOST (routes/filehost.ts): goguma and gamja read it on a bound
// connection, halloy on the unbound one, so both carry it.
describe('soju.im/FILEHOST in ISUPPORT', () => {
  const TOKEN = 'soju.im/FILEHOST=https://irc.example.test/api/filehost';

  // The 005 lines a client gets up to its 422.
  async function isupportFor(
    bound: boolean,
    registration?: (nick: string) => string[],
  ): Promise<string> {
    const acct = harnessMod.seedAccount({ nick: `fh${Math.random().toString(36).slice(2, 7)}` });
    if (registration) acct.upstream.registrationLines = registration(acct.upstream.currentNick);
    const c = await harness.connect();
    if (bound) {
      c.send(`PASS ${acct.user.username}:${acct.password}`);
      c.send('NICK client');
      c.send('USER client 0 * :client');
    } else {
      harnessMod.seedNetwork(acct.user, { networkName: 'second' });
      await negotiate(c, acct, 'sasl soju.im/bouncer-networks');
      c.send('CAP END');
    }
    await c.waitForCommand('422');
    c.close();
    return c.lines.filter((l) => harnessMod.commandOf(l) === '005').join('\n');
  }

  async function withBaseUrl<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.PUBLIC_BASE_URL;
    if (value === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = prev;
    }
  }

  it('is advertised on bound and control connections with an https PUBLIC_BASE_URL', async () => {
    await withBaseUrl('https://irc.example.test/', async () => {
      expect(await isupportFor(true)).toContain(TOKEN);
      expect(await isupportFor(false)).toContain(TOKEN);
    });
  });

  it('is advertised for a base with whitespace around it', async () => {
    await withBaseUrl(`  https://irc.example.test/  `, async () => {
      expect(await isupportFor(true)).toContain(TOKEN);
    });
  });

  it('is not advertised without a usable https PUBLIC_BASE_URL', async () => {
    await withBaseUrl(undefined, async () => {
      expect(await isupportFor(true)).not.toContain('FILEHOST');
    });
    const advertised: string[] = [];
    for (const base of [
      'https://irc.example.test?x=1',
      'https://irc.example.test#top',
      'https://admin:secret@irc.example.test',
      'https://irc.example.test:99999',
    ]) {
      await withBaseUrl(base, async () => {
        if ((await isupportFor(true)).includes('FILEHOST')) advertised.push(base);
      });
    }
    expect(advertised).toEqual([]);
    await withBaseUrl('http://irc.example.test', async () => {
      expect(await isupportFor(true)).not.toContain('FILEHOST');
      expect(await isupportFor(false)).not.toContain('FILEHOST');
    });
  });

  // A client uploads to the URL with its Lurker credentials, so a network's own
  // (an upstream soju's) must not reach it, advertised or not.
  it("never passes on the network's own FILEHOST", async () => {
    const registration = (nick: string) => [
      `:irc.example.net 001 ${nick} :Welcome`,
      `:irc.example.net 005 ${nick} CHANTYPES=# soju.im/FILEHOST=https://upstream.example/up draft/FILEHOSTING=1 :are supported by this server`,
      `:irc.example.net 005 ${nick} FILEHOST=https://upstream.example/x :are supported by this server`,
      `:irc.example.net 005 ${nick} -vendor.example/filehost :are supported by this server`,
      // With no text after the tokens, which halloy would read the last of.
      `:irc.example.net 005 ${nick} AWAYLEN=200 soju.im/FILEHOST=https://upstream.example/y`,
      `:irc.example.net 005 ${nick} SAFELIST :soju.im/FILEHOST=https://upstream.example/z`,
      `:irc.example.net 005 ${nick} soju.im/FILEHOST=https://upstream.example/w`,
    ];
    await withBaseUrl(undefined, async () => {
      expect(await isupportFor(true, registration)).toBe(
        [
          ':irc.example.net 005 client CHANTYPES=# draft/FILEHOSTING=1 :are supported by this server',
          ':irc.example.net 005 client AWAYLEN=200',
          ':irc.example.net 005 client SAFELIST',
        ].join('\n'),
      );
    });
    await withBaseUrl('https://irc.example.test', async () => {
      const isupport = await isupportFor(true, registration);
      expect(isupport).toContain(TOKEN);
      expect(isupport).not.toContain('upstream.example');
    });
  });

  // A network's later 005 isn't relayed at all (RELAY_DROP); IrcConnection adds
  // it to registrationLines, whose replay strips the token.
  it("doesn't relay a network's own FILEHOST sent after registration", async () => {
    const acct = harnessMod.seedAccount({ nick: 'fhlive' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    const from = c.lines.length;
    acct.upstream.pushUpstream(
      `:irc.example.net 005 fhlive soju.im/FILEHOST=https://upstream.example/up :are supported by this server`,
    );
    acct.upstream.pushUpstream(':bot!b@h PRIVMSG #chan :sentinel');
    await c.waitFor((l) => l.endsWith(':sentinel'));
    expect(c.lines.slice(from).join('\n')).not.toContain('upstream.example');
    c.close();
  });

  it('is not advertised to an account with no usable uploader', async () => {
    const { default: db } = await import('../db/index.js');
    const defaults = db
      .prepare(`SELECT id FROM uploader_config WHERE scope = 'instance' AND is_default = 1`)
      .all() as Array<{ id: number }>;
    db.prepare(`UPDATE uploader_config SET is_default = 0 WHERE scope = 'instance'`).run();
    try {
      await withBaseUrl('https://irc.example.test', async () => {
        expect(await isupportFor(true)).not.toContain('FILEHOST');
      });
    } finally {
      for (const { id } of defaults) {
        db.prepare('UPDATE uploader_config SET is_default = 1 WHERE id = ?').run(id);
      }
    }
  });
});
