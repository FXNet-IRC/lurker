// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for IRCv3 draft/chathistory: CHATHISTORY BEFORE/AFTER/
// LATEST/BETWEEN/AROUND/TARGETS over the message store. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-chathistory');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let insertMessage: typeof import('../db/messages.js').insertMessage;
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ({ insertMessage } = await import('../db/messages.js'));
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

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

const HISTORY_CAPS = 'sasl batch server-time message-tags draft/chathistory';

// Bind a single-network account (auto-binds without bouncer-networks) with the
// history-relevant caps negotiated.
async function attachBound(
  c: Client,
  acct: { user: { username: string }; password: string },
  caps = HISTORY_CAPS,
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
  c.send('CAP END');
  await c.waitForCommand('422');
}

function seedMessages(networkId: number, target: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    ids.push(
      Number(
        insertMessage({
          networkId,
          target,
          time: `2023-05-23T06:00:0${i}.000Z`,
          type: 'message',
          nick: 'bob',
          userhost: 'bob!u@h',
          text: `msg${i}`,
          self: false,
        }).id,
      ),
    );
  }
  return ids;
}

// Collect the BOUNCER... err, chathistory batch lines between BATCH +/- for a ref.
function batchBodies(lines: string[], ref: string): string[] {
  return lines.filter((l) => l.includes(`@batch=${ref}`) || l.includes(`;batch=${ref}`));
}

describe('CHATHISTORY advertisement', () => {
  it('advertises CHATHISTORY + MSGREFTYPES in ISUPPORT when the cap is negotiated', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch1' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('CHATHISTORY='));
    expect(isupport).toBeTruthy();
    expect(isupport).toContain('CHATHISTORY=1000');
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    c.close();
  });
});

describe('attach playback', () => {
  // A joined channel and a DM, both with history.
  async function attachWithHistory(nick: string, caps: string): Promise<Client> {
    const acct = harnessMod.seedAccount({ nick });
    acct.upstream.addChannel('#room', { members: [nick, 'bob'] });
    seedMessages(acct.network.id, '#room', 2);
    seedMessages(acct.network.id, 'bob', 1);
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    // Playback goes out in the same pass as the 422, so the PONG comes after it.
    c.send('PING sync');
    await c.waitForCommand('PONG');
    return c;
  }

  it('sends none to a client that negotiated draft/chathistory', async () => {
    // soju skips it too (downstream.go:1841): the client fetches its own
    // history, so a replay shows every line twice.
    const c = await attachWithHistory('ap1', HISTORY_CAPS);
    expect(c.lines.some((l) => l.includes('JOIN #room'))).toBe(true);
    expect(c.lines.filter((l) => l.includes(' PRIVMSG '))).toEqual([]);
    c.close();
  });

  it('still replays channels and DMs to a client without it', async () => {
    const c = await attachWithHistory('ap2', 'sasl batch server-time message-tags');
    expect(c.lines.some((l) => l.includes('PRIVMSG #room :msg2'))).toBe(true);
    expect(c.lines.some((l) => l.includes('PRIVMSG ap2 :msg1'))).toBe(true);
    c.close();
  });

  it("carries the network's msgid to a client with message-tags", async () => {
    const acct = harnessMod.seedAccount({ nick: 'ap3' });
    acct.upstream.addChannel('#room', { members: ['ap3', 'bob'] });
    insertMessage({
      networkId: acct.network.id,
      target: '#room',
      time: '2023-05-23T06:00:01.000Z',
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: 'played back',
      self: false,
      msgid: 'upstream-pb-1',
    });
    const c = await harness.connect();
    await attachBound(c, acct, 'sasl batch server-time message-tags');
    c.send('PING sync');
    await c.waitForCommand('PONG');
    const line = c.lines.find((l) => l.includes('PRIVMSG #room :played back'));
    expect(line).toContain(';msgid=upstream-pb-1 :bob!u@h');
    c.close();
  });
});

describe('CHATHISTORY LATEST', () => {
  it('returns the newest messages oldest-first, in a chathistory batch with time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch2' });
    seedMessages(acct.network.id, '#room', 3);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #room * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    expect(open).toContain('chathistory #room');
    const m1 = await c.waitFor((l) => l.includes('PRIVMSG #room :msg1'));
    expect(m1).toContain('time=2023-05-23T06:00:01.000Z');
    expect(m1).toContain(`batch=${ref}`);
    await c.waitFor((l) => l.includes('msg3'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('CHATHISTORY msgids', () => {
  const BACKSLASH = String.fromCharCode(92);
  const NEWLINE = String.fromCharCode(10);

  // One stored message in #tagged, then the batch CHATHISTORY returns for it.
  async function historyOf(
    nick: string,
    row: Partial<Parameters<typeof insertMessage>[0]>,
    caps = HISTORY_CAPS,
  ): Promise<string[]> {
    const acct = harnessMod.seedAccount({ nick });
    insertMessage({
      networkId: acct.network.id,
      target: '#tagged',
      time: '2023-05-23T06:00:01.000Z',
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: 'tagged msg',
      self: false,
      ...row,
    });
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    c.send('CHATHISTORY LATEST #tagged * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    return batchBodies(c.lines, ref);
  }

  it("carries the network's msgid, not Lurker's row id", async () => {
    // The spec wants the msgid "as originally sent by the IRC server", the one a
    // client saw on the line live. A row id was a second id for the same message.
    const lines = await historyOf('mid1', { msgid: 'upstream-uuid-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(';msgid=upstream-uuid-1 :bob!u@h PRIVMSG #tagged :tagged msg');
  });

  it('carries no msgid for a message the network gave none', async () => {
    const lines = await historyOf('mid2', {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });

  it('escapes the msgid as a tag value', async () => {
    const lines = await historyOf('mid3', { msgid: `a;b c${BACKSLASH}d` });
    const escaped = `a${BACKSLASH}:b${BACKSLASH}sc${BACKSLASH}${BACKSLASH}d`;
    expect(lines[0]).toContain(`;msgid=${escaped} :bob!u@h PRIVMSG`);
  });

  it('puts the msgid on the first line of a multiline message, and sends no blank lines', async () => {
    // As the live multiline fallback does: halloy drops a later line that
    // repeats an id as a duplicate.
    const text = ['one', 'two', '', 'three'].join(NEWLINE);
    const lines = await historyOf('mid4', { msgid: 'ml-1', text });
    expect(lines.map((l) => l.slice(l.indexOf(' :bob!u@h ')))).toEqual([
      ' :bob!u@h PRIVMSG #tagged :one',
      ' :bob!u@h PRIVMSG #tagged :two',
      ' :bob!u@h PRIVMSG #tagged :three',
    ]);
    expect(lines[0]).toContain('msgid=ml-1');
    expect(lines.slice(1).some((l) => l.includes('msgid='))).toBe(false);
  });

  it('carries no msgid for a decrypted E2E message', async () => {
    // Its msgid names the ciphertext line, which the client got live under that
    // id. halloy would take this readable copy as a duplicate of that one.
    const lines = await historyOf('mid5', { msgid: 'cipher-1', extra: { e2e: true } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });

  it('carries no msgid to a client without message-tags', async () => {
    const lines = await historyOf(
      'mid6',
      { msgid: 'upstream-uuid-6' },
      'sasl batch server-time draft/chathistory',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });
});

describe('CHATHISTORY BEFORE / AFTER (timestamp, exclusive)', () => {
  it('BEFORE excludes messages at or after the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch3' });
    seedMessages(acct.network.id, '#r', 4); // at :01 :02 :03 :04
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY BEFORE #r timestamp=2023-05-23T06:00:03.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    await c.waitFor((l) => l.includes('msg1'));
    await c.waitFor((l) => l.includes('msg2'));
    await c.waitFor((l) => l.includes('BATCH -'));
    // msg3 (at the bound) and msg4 must NOT appear.
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg3'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg4'))).toBe(false);
  });

  it('AFTER excludes messages at or before the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch4' });
    seedMessages(acct.network.id, '#r', 4);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY AFTER #r timestamp=2023-05-23T06:00:02.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +'));
    await c.waitFor((l) => l.includes('msg3'));
    await c.waitFor((l) => l.includes('msg4'));
    await c.waitFor((l) => l.includes('BATCH -'));
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg1'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg2'))).toBe(false);
  });

  it('a netsplit of joins does not truncate the batch (limit counts real messages)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chns' });
    seedMessages(acct.network.id, '#split', 1); // one real message at :01
    // Then a flood of joins (non-replayable) at :02..:09.
    for (let i = 2; i <= 9; i++) {
      insertMessage({
        networkId: acct.network.id,
        target: '#split',
        time: `2023-05-23T06:00:0${i}.000Z`,
        type: 'join',
        nick: `joiner${i}`,
        self: false,
      });
    }
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #split * 3');
    await c.waitFor((l) => l.includes('BATCH +'));
    // The real message is returned even though the newest rows are all joins.
    const line = await c.waitFor((l) => l.includes('PRIVMSG #split :msg1'));
    expect(line).toContain('PRIVMSG #split :msg1');
    await c.waitFor((l) => l.includes('BATCH -'));
  });
});

describe('CHATHISTORY msgid rejected', () => {
  it('rejects a msgid selector (timestamp-only, MSGREFTYPES=timestamp)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chm' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('MSGREFTYPES'));
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    expect(isupport).not.toContain('msgid');
    c.send('CHATHISTORY BEFORE #r msgid=5 100');
    const fail = await c.waitForCommand('FAIL');
    // A well-formed selector of a type we don't implement gets the spec's
    // dedicated code, NOT INVALID_PARAMS — the client's syntax was fine, the
    // reftype isn't offered, and only INVALID_MSGREFTYPE says so.
    //
    // Asserted as a full param sequence, not substrings: the spec layout is
    // `<command> <target> [context]`, and a substring check would happily pass
    // while the target was missing and the client mistook `msgid=5` for a
    // buffer name.
    expect(fail).toContain('FAIL CHATHISTORY INVALID_MSGREFTYPE BEFORE #r msgid=5 :');
    expect(fail).toContain('Unsupported message reference type');
    c.close();
  });
});

describe('CHATHISTORY TARGETS', () => {
  it('lists active buffers with their last-activity time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch6' });
    seedMessages(acct.network.id, '#alpha', 2);
    seedMessages(acct.network.id, '#beta', 1);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send(
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100',
    );
    const open = await c.waitFor((l) => l.includes('draft/chathistory-targets'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const alpha = await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #alpha'));
    // The target line carries the buffer's last-activity server-time.
    expect(alpha).toContain('2023-05-23T06:00:02.000Z');
    expect(alpha).toContain(`@batch=${ref}`);
    await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #beta'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('CHATHISTORY errors', () => {
  it('rejects a limit over the advertised maximum', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch7' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #r * 99999');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid limit');
    c.close();
  });

  it('rejects a malformed bound', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch8' });
    const c = await harness.connect();
    await attachBound(c, acct);
    // A SUPPORTED reftype carrying an unparseable value — that's a syntax error
    // the client can fix, so it stays INVALID_PARAMS. (Deliberately not a
    // `msgid=` selector: that's an unsupported reftype, covered above.)
    c.send('CHATHISTORY BEFORE #r timestamp=notatimestamp 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid first bound');
    c.close();
  });

  it('refuses CHATHISTORY on a control (unbound) connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch9' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ch9b' });
    const c = await harness.connect();
    // Control mode: bouncer-networks cap, no network selector.
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl draft/chathistory soju.im/bouncer-networks');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('CHATHISTORY LATEST #r * 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_TARGET');
    c.close();
  });

  it('returns an empty batch (not a FAIL) when there is no history', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch10' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #empty * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const close = await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    expect(close).toBeTruthy();
    expect(batchBodies(c.lines, ref)).toHaveLength(0);
  });
});

describe('draft/event-playback', () => {
  const EVENT_CAPS = `${HISTORY_CAPS} draft/event-playback`;
  const at = (s: number) => `2023-05-23T06:00:${String(s).padStart(2, '0')}.000Z`;

  // Rows in `target`, one second apart from :01, then the lines one CHATHISTORY
  // command returns for them.
  async function history(
    nick: string,
    target: string,
    rows: Array<Partial<Parameters<typeof insertMessage>[0]>>,
    command: string,
    caps = EVENT_CAPS,
  ): Promise<{ lines: string[]; ref: string }> {
    const acct = harnessMod.seedAccount({ nick });
    rows.forEach((row, i) =>
      insertMessage({
        networkId: acct.network.id,
        target,
        time: at(i + 1),
        type: 'message',
        nick: 'bob',
        self: false,
        ...row,
      } as Parameters<typeof insertMessage>[0]),
    );
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    c.send(command);
    const open = await c.waitFor((l) => l.includes('BATCH +'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    return { lines: batchBodies(c.lines, ref), ref };
  }

  const EVENTS: Array<Partial<Parameters<typeof insertMessage>[0]>> = [
    { type: 'message', nick: 'bob', userhost: 'bob!u@h', text: 'hi' },
    { type: 'join', nick: 'alice', userhost: 'alice!a@h', extra: { account: 'alice' } },
    { type: 'part', nick: 'alice', userhost: 'alice!a@h', text: 'bye now' },
    { type: 'quit', nick: 'carol', userhost: 'carol!c@h', text: 'Quit: gone' },
    { type: 'nick', nick: 'dave', userhost: 'dave!d@h', extra: { newNick: 'david' } },
    { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'spam', extra: { kicked: 'eve' } },
    { type: 'mode', nick: 'op', text: '+o bob', extra: { modes: [] } },
    { type: 'topic', nick: 'op', text: 'new topic' },
  ];

  it('is offered', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes(' LS '));
    expect(ls).toContain('draft/event-playback');
    c.close();
  });

  it('replays joins, parts, quits, nick changes, kicks, and mode and topic changes', async () => {
    const { lines, ref } = await history('ep1', '#ev', EVENTS, 'CHATHISTORY LATEST #ev * 100');
    const tag = (s: number) => `@batch=${ref};time=${at(s)} `;
    expect(lines).toEqual([
      `${tag(1)}:bob!u@h PRIVMSG #ev :hi`,
      // Plain: the realname an extended JOIN carries isn't stored.
      `${tag(2)}:alice!a@h JOIN #ev`,
      `${tag(3)}:alice!a@h PART #ev :bye now`,
      `${tag(4)}:carol!c@h QUIT :Quit: gone`,
      `${tag(5)}:dave!d@h NICK david`,
      `${tag(6)}:op!o@h KICK #ev eve :spam`,
      `${tag(7)}:op!op@lurker.bouncer MODE #ev +o bob`,
      `${tag(8)}:op!op@lurker.bouncer TOPIC #ev :new topic`,
    ]);
  });

  it('replays only messages to a client that did not ask', async () => {
    const { lines } = await history(
      'ep2',
      '#ev',
      EVENTS,
      'CHATHISTORY LATEST #ev * 100',
      HISTORY_CAPS,
    );
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([':bob!u@h PRIVMSG #ev :hi']);
  });

  it('leaves out host changes and invites, which soju replays neither of', async () => {
    const { lines } = await history(
      'ep3',
      '#ev',
      [
        { type: 'chghost', nick: 'alice', userhost: 'alice!a@h', extra: { newHost: 'h2' } },
        { type: 'invite', nick: 'op', extra: { invited: 'frank' } },
        { type: 'join', nick: 'alice', userhost: 'alice!a@h' },
      ],
      'CHATHISTORY LATEST #ev * 100',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(':alice!a@h JOIN #ev');
  });

  it('counts events toward the limit', async () => {
    const { lines } = await history('ep4', '#ev', EVENTS, 'CHATHISTORY LATEST #ev * 3');
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['KICK', 'MODE', 'TOPIC']);
  });

  // goguma applies every replayed line to its live state: an old PART from its
  // own nick marks the channel as left, an old NICK from it renames us.
  it('leaves out events naming our current nick, before the limit is applied', async () => {
    const { lines } = await history(
      'ep5',
      '#ev',
      [
        { type: 'join', nick: 'zed', userhost: 'zed!z@h' },
        { type: 'kick', nick: 'EP5', userhost: 'EP5!e@h', text: 'bye', extra: { kicked: 'zed' } },
        { type: 'join', nick: 'Ep5', userhost: 'Ep5!e@h' },
        { type: 'part', nick: 'ep5', userhost: 'ep5!e@h', text: 'later' },
        { type: 'nick', nick: 'EP5', userhost: 'EP5!e@h', extra: { newNick: 'ep5_' } },
        { type: 'quit', nick: 'ep5', userhost: 'ep5!e@h', text: 'bye' },
        { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'out', extra: { kicked: 'eP5' } },
      ],
      'CHATHISTORY LATEST #ev * 2',
    );
    // Our kick of someone else still goes, and nothing else fills the limit.
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([
      ':zed!z@h JOIN #ev',
      ':EP5!e@h KICK #ev zed :bye',
    ]);
  });

  it('names the server as the source of a mode it set', async () => {
    const { lines } = await history(
      'ep6',
      '#ev',
      [{ type: 'mode', nick: 'irc.example.net', text: '+nt', extra: { modes: [] } }],
      'CHATHISTORY LATEST #ev * 100',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' :irc.example.net MODE #ev +nt');
  });

  it('lists a buffer with only events among TARGETS, for a client that asked', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    const rows = [{ type: 'join', nick: 'alice', userhost: 'alice!a@h' }];
    const withEvents = await history('ep7', '#joinsonly', rows, window);
    expect(withEvents.lines.some((l) => l.includes('TARGETS #joinsonly'))).toBe(true);
    const without = await history('ep8', '#joinsonly', rows, window, HISTORY_CAPS);
    expect(without.lines.some((l) => l.includes('TARGETS #joinsonly'))).toBe(false);
  });

  it("keeps a buffer's joins from using up its attach playback", async () => {
    const acct = harnessMod.seedAccount({ nick: 'ep9' });
    acct.upstream.addChannel('#busy', { members: ['ep9', 'bob'] });
    seedMessages(acct.network.id, '#busy', 2);
    for (let s = 3; s <= 6; s++) {
      insertMessage({
        networkId: acct.network.id,
        target: '#busy',
        time: at(s),
        type: 'join',
        nick: `joiner${s}`,
        self: false,
      });
    }
    process.env.LURKER_BOUNCER_PLAYBACK = '2';
    try {
      const c = await harness.connect();
      await attachBound(c, acct, 'sasl batch server-time message-tags draft/event-playback');
      c.send('PING sync');
      await c.waitForCommand('PONG');
      expect(c.lines.filter((l) => l.includes('PRIVMSG #busy'))).toHaveLength(2);
      // Attach playback never replays events, even to a client that asked.
      expect(c.lines.some((l) => l.includes('joiner'))).toBe(false);
      c.close();
    } finally {
      delete process.env.LURKER_BOUNCER_PLAYBACK;
    }
  });
});
