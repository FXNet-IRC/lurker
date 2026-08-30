// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
// Pure, no DB side effects — safe to import statically alongside the lazy
// db-layer imports below.
import { CONSOLIDATABLE_TYPES } from '../../shared/consolidate.js';
import { NOISE_TYPES } from '../../shared/eventFilter.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let listMessages: typeof import('./messages.js').listMessages;
let listMessagesAround: typeof import('./messages.js').listMessagesAround;
let listMessagesCounted: typeof import('./messages.js').listMessagesCounted;
let searchMessages: typeof import('./messages.js').searchMessages;
let countNewer: typeof import('./messages.js').countNewer;
let hasMoreThan: typeof import('./messages.js').hasMoreThan;
let countServerBufferUnread: typeof import('./messages.js').countServerBufferUnread;
let typeCountsForUnread: typeof import('./messages.js').typeCountsForUnread;
let countHighlightsNewer: typeof import('./messages.js').countHighlightsNewer;
let listUserHighlights: typeof import('./messages.js').listUserHighlights;
let maxIdForBuffer: typeof import('./messages.js').maxIdForBuffer;
let hasConversationForTarget: typeof import('./messages.js').hasConversationForTarget;
let listSpeakers: typeof import('./messages.js').listSpeakers;
let listBufferTargets: typeof import('./messages.js').listBufferTargets;
let loadHistoryWindow: typeof import('./messages.js').loadHistoryWindow;
let listActiveTargetsInWindow: typeof import('./messages.js').listActiveTargetsInWindow;
let demoteLegacyServerStatusNotices: typeof import('./index.js').demoteLegacyServerStatusNotices;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ demoteLegacyServerStatusNotices } = await import('./index.js'));
  ({
    insertMessage,
    listMessages,
    listMessagesAround,
    listMessagesCounted,
    searchMessages,
    countNewer,
    hasMoreThan,
    countServerBufferUnread,
    typeCountsForUnread,
    countHighlightsNewer,
    listUserHighlights,
    maxIdForBuffer,
    hasConversationForTarget,
    listSpeakers,
    listBufferTargets,
    loadHistoryWindow,
    listActiveTargetsInWindow,
  } = await import('./messages.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function chat(networkId: number, target: string, nick: string, text: string, type = 'message') {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type,
    nick,
    text,
    self: false,
  });
  return { id: Number(result.id), alt: result.alt };
}

function event(networkId: number, target: string, type: string, nick: string | null = null) {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type,
    nick,
    self: false,
  });
  return { id: Number(result.id), alt: result.alt };
}

/** A mode row carrying a stamped change list, the way ircConnection publishes it. */
function modeEvent(
  networkId: number,
  target: string,
  modes: Array<{ mode: string; param?: string; kind?: string }>,
) {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type: 'mode',
    nick: 'ChanServ',
    self: false,
    extra: { modes },
  });
  return { id: Number(result.id), alt: result.alt };
}

function altsFor(networkId: number, target: string) {
  return listMessages(networkId, target, { limit: 1000 }).map((m) => m.alt);
}

describe('countServerBufferUnread (#470)', () => {
  let seq = 0;
  const net = () => {
    const user = createUser(`sbu-${++seq}`);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;
  };
  const put = (
    networkId: number,
    target: string,
    type: string,
    opts: { nick?: string; notable?: boolean; fromIgnored?: boolean; mirrored?: boolean } = {},
  ) =>
    Number(
      insertMessage({
        networkId,
        target,
        time: new Date().toISOString(),
        type,
        nick: opts.nick ?? 'someone',
        text: 'x',
        self: false,
        notable: opts.notable,
        fromIgnored: opts.fromIgnored,
        mirrored: opts.mirrored,
      }).id,
    );

  it('counts errors, inbound notices/messages, and mirrors; skips Lurker status notices', () => {
    const n = net();
    const target = `:server:${n}`;
    put(n, target, 'error'); // killed/banned/etc. — countNewer would NOT count this
    put(n, target, 'notice', { nick: 'NickServ' }); // inbound notice
    put(n, target, 'message', { nick: 'irc.server' }); // server message
    put(n, target, 'notice', { nick: 'ChanServ', mirrored: true }); // closed-buffer mirror → still counts
    put(n, target, 'notice', { nick: 'lurker', notable: false }); // "Connecting…" — must NOT count
    put(n, target, 'notice', { nick: 'lurker', notable: false }); // "Reconnecting…" — must NOT count

    expect(countServerBufferUnread(n, target, 0)).toBe(4);
    // The generic channel count disagrees on BOTH axes: it drops the 'error' but
    // counts the two notable=0 Lurker status notices (it ignores the flag) — so it
    // sees the 5 notice/message rows and misses the error. Exactly why :server:
    // needs its own count.
    expect(countNewer(n, target, 0)).toBe(5);
  });

  it('honors the read pointer and excludes ignored senders', () => {
    const n = net();
    const target = `:server:${n}`;
    const a = put(n, target, 'notice', { nick: 'a' });
    put(n, target, 'notice', { nick: 'b' });
    put(n, target, 'notice', { nick: 'spammer', fromIgnored: true }); // ignored → not counted
    expect(countServerBufferUnread(n, target, 0)).toBe(2);
    expect(countServerBufferUnread(n, target, a)).toBe(1); // only lines after `a`
  });

  it('returns 0 when every server line is a non-notable Lurker status notice', () => {
    const n = net();
    const target = `:server:${n}`;
    put(n, target, 'notice', { nick: 'lurker', notable: false });
    put(n, target, 'notice', { nick: 'lurker', notable: false });
    expect(countServerBufferUnread(n, target, 0)).toBe(0);
  });

  it('typeCountsForUnread: :server: counts errors, other buffers do not — matches the count queries', () => {
    // This is the rule the live read-state-broadcast trigger uses (wsHub). A
    // :server: 'error' (a disconnect/quit echo, a kill/ban) must count here, or
    // its badge wouldn't refresh until the next ordinary countable event — the
    // delayed-badge bug. Everything countNewer counts still counts everywhere.
    expect(typeCountsForUnread(':server:1', 'error')).toBe(true);
    expect(typeCountsForUnread(':server:1', 'notice')).toBe(true);
    expect(typeCountsForUnread(':server:1', 'message')).toBe(true);
    expect(typeCountsForUnread(':server:1', 'motd')).toBe(false); // motd never counts
    // Channels/DMs keep the narrower set: an error there doesn't badge.
    expect(typeCountsForUnread('#chan', 'error')).toBe(false);
    expect(typeCountsForUnread('#chan', 'message')).toBe(true);
    expect(typeCountsForUnread('bob', 'notice')).toBe(true);
  });

  it('backfill demotes historical Lurker :server: status notices, sparing inbound and channel rows', () => {
    const n = net();
    const server = `:server:${n}`;
    // Simulate PRE-migration rows: all notable=1 (the column default), including
    // Lurker's own status notices, which were only tagged notable=false going
    // forward. A real inbound :server: notice and a #channel notice from a
    // (coincidentally) 'lurker'-nicked sender must survive the backfill.
    put(n, server, 'notice', { nick: 'lurker' }); // status notice → should be demoted
    put(n, server, 'notice', { nick: 'NickServ' }); // inbound → keep
    put(n, '#room', 'notice', { nick: 'lurker' }); // wrong buffer → keep (LIKE ':server:%' scope)
    expect(countServerBufferUnread(n, server, 0)).toBe(2);
    expect(countServerBufferUnread(n, '#room', 0)).toBe(1);

    demoteLegacyServerStatusNotices();

    expect(countServerBufferUnread(n, server, 0)).toBe(1); // only the status notice dropped
    expect(countServerBufferUnread(n, '#room', 0)).toBe(1); // channel row untouched
  });
});

describe('hasConversationForTarget (#439)', () => {
  it('is true only when a non-notice message exists for the target', () => {
    const user = createUser('conv-target');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'conv-target',
    });
    // Notice-only buffer (a service) → not a conversation.
    chat(net!.id, 'NickServ', 'NickServ', 'you are now identified', 'notice');
    expect(hasConversationForTarget(net!.id, 'NickServ')).toBe(false);
    // A real PRIVMSG promotes it to a conversation; an ACTION counts too.
    chat(net!.id, 'bob', 'bob', 'hey there');
    expect(hasConversationForTarget(net!.id, 'bob')).toBe(true);
    chat(net!.id, 'carol', 'carol', 'waves', 'action');
    expect(hasConversationForTarget(net!.id, 'carol')).toBe(true);
    // Case-insensitive match; unknown target is false.
    expect(hasConversationForTarget(net!.id, 'BOB')).toBe(true);
    expect(hasConversationForTarget(net!.id, 'nobody')).toBe(false);
  });
});

describe('listBufferTargets (loose-index-scan)', () => {
  let seq = 0;
  function net() {
    const user = createUser(`bt-${++seq}`);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;
  }

  it('returns the distinct targets, sorted, deduped across many rows', () => {
    const n = net();
    // Interleave several targets with duplicates; the scan must return each once.
    for (let i = 0; i < 30; i++) {
      chat(n, '#zeta', 'a', 'x');
      chat(n, '#alpha', 'b', 'y');
      chat(n, 'dave', 'dave', 'z');
    }
    chat(n, ':server:1', 'lurker', 'notice');
    // Binary collation: '#'(0x23) < ':'(0x3A) < 'a' < 'd'. The stray
    // ':server:1' (a foreign network number, the shape a legacy import
    // produces) resolves into THIS network's own server buffer — targets come
    // back canonical from the registry, so the list reports :server:<n>.
    expect(listBufferTargets(n)).toEqual(['#alpha', '#zeta', `:server:${n}`, 'dave']);
  });

  it('returns [] for a network with no messages', () => {
    expect(listBufferTargets(net())).toEqual([]);
  });
});

describe('listSpeakers', () => {
  // Deterministic unique user per network — no Math.random (reproducible, no
  // rare collision flake).
  let seq = 0;
  function net() {
    const user = createUser(`spk-${++seq}`);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;
  }

  it('returns recent distinct speakers, case-folded, excluding self and non-chat', () => {
    const n = net();
    chat(n, '#c', 'Alice', 'hi');
    chat(n, '#c', 'alice', 'again'); // same speaker, divergent case → one entry
    chat(n, '#c', 'Bob', 'yo');
    event(n, '#c', 'join', 'Carol'); // non-chat → not a speaker
    insertMessage({
      networkId: n,
      target: '#c',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'me',
      text: 'self line',
      self: true, // our own line → excluded
    });
    const nicks = listSpeakers(n, '#c').map((s) => s.nick.toLowerCase());
    expect(new Set(nicks)).toEqual(new Set(['alice', 'bob']));
  });

  it('bounds the scan to the recent window — older speakers outside it drop off', () => {
    const n = net();
    chat(n, '#c', 'oldtimer', 'first'); // oldest chat line
    for (let i = 0; i < 5; i++) chat(n, '#c', `recent${i}`, 'x');
    // With a scan window of 3, only the 3 newest rows are considered, so
    // 'oldtimer' (6 rows back) is excluded even though it's real chat history.
    const nicks = listSpeakers(n, '#c', 20, 3).map((s) => s.nick);
    expect(nicks).not.toContain('oldtimer');
    // Unbounded (default window) still finds it.
    expect(listSpeakers(n, '#c').map((s) => s.nick)).toContain('oldtimer');
  });

  it('window counts CHAT rows only — an event flood does not starve speakers', () => {
    const n = net();
    chat(n, '#c', 'speaker', 'hi'); // one chat line...
    for (let i = 0; i < 8; i++) event(n, '#c', 'join', `joiner${i}`); // ...then a join flood
    // Window of 2. The filters run INSIDE the window, so the 8 joins are skipped
    // rather than filling it; the one chat row still lands in-window. If the
    // filters ran AFTER the id-DESC LIMIT (the netsplit-starvation bug), a window
    // of 2 would be [join7, join6] → filtered to empty → no speaker.
    const nicks = listSpeakers(n, '#c', 20, 2).map((s) => s.nick);
    expect(nicks).toContain('speaker');
    expect(nicks.some((x) => x.startsWith('joiner'))).toBe(false);
  });
});

describe('messages.alt parity', () => {
  it('alternates alt for chat-shaped types within a buffer', () => {
    const user = createUser('parity-basic');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-basic',
    });
    chat(net!.id, '#a', 'alice', 'one');
    chat(net!.id, '#a', 'bob', 'two');
    chat(net!.id, '#a', 'alice', 'three');
    chat(net!.id, '#a', 'bob', 'four');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false, true]);
  });

  it('does not flip parity on system events', () => {
    const user = createUser('parity-events');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-events',
    });
    chat(net!.id, '#a', 'alice', 'one');
    event(net!.id, '#a', 'join', 'carol');
    event(net!.id, '#a', 'part', 'carol');
    chat(net!.id, '#a', 'bob', 'two');
    event(net!.id, '#a', 'mode');
    chat(net!.id, '#a', 'alice', 'three');

    const events = listMessages(net!.id, '#a', { limit: 1000 });
    const chatAlts = events
      .filter((m) => ['message', 'action', 'notice'].includes(m.type))
      .map((m) => m.alt);
    expect(chatAlts).toEqual([false, true, false]);
    const sysAlts = events
      .filter((m) => !['message', 'action', 'notice'].includes(m.type))
      .map((m) => m.alt);
    expect(sysAlts.every((a) => a === false)).toBe(true);
  });

  it('tracks parity independently per buffer', () => {
    const user = createUser('parity-isolation');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-isolation',
    });
    chat(net!.id, '#a', 'alice', 'a1');
    chat(net!.id, '#b', 'alice', 'b1');
    chat(net!.id, '#a', 'alice', 'a2');
    chat(net!.id, '#b', 'alice', 'b2');
    chat(net!.id, '#a', 'alice', 'a3');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false]);
    expect(altsFor(net!.id, '#b')).toEqual([false, true]);
  });

  it('treats action and notice as striped types', () => {
    const user = createUser('parity-actions');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-actions',
    });
    chat(net!.id, '#a', 'alice', 'one', 'message');
    chat(net!.id, '#a', 'alice', 'two', 'action');
    chat(net!.id, '#a', 'alice', 'three', 'notice');
    chat(net!.id, '#a', 'alice', 'four', 'message');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false, true]);
  });
});

describe('searchMessages', () => {
  it('excludes mirrored server-buffer copies but keeps the real copy (#439)', () => {
    const user = createUser('search-mirror');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-mirror',
    });
    // The real copy in the sender's (closed) buffer, plus the mirrored duplicate
    // in the server buffer — same text. Search must return only the real one.
    insertMessage({
      networkId: net!.id,
      target: 'NickServ',
      time: new Date().toISOString(),
      type: 'notice',
      nick: 'NickServ',
      text: 'your unique-cloak-token is set',
      self: false,
    });
    insertMessage({
      networkId: net!.id,
      target: `:server:${net!.id}`,
      time: new Date().toISOString(),
      type: 'notice',
      nick: 'NickServ',
      text: 'your unique-cloak-token is set',
      self: false,
      mirrored: true,
    });
    const hits = searchMessages(user.id, { query: 'unique-cloak-token' });
    expect(hits).toHaveLength(1);
    expect(hits[0].target).toBe('NickServ');
  });

  it('matches free text against message bodies', () => {
    const user = createUser('search-text');
    const net = createNetwork(user.id, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-text',
    });
    chat(net!.id, '#a', 'alice', 'the release deadline is friday');
    chat(net!.id, '#a', 'bob', 'unrelated chatter');
    chat(net!.id, '#a', 'carol', 'another deadline slipped');

    const hits = searchMessages(user.id, { query: 'deadline' });
    expect(hits.map((m) => m.text).toSorted()).toEqual([
      'another deadline slipped',
      'the release deadline is friday',
    ]);
  });

  it('ANDs multiple free-text terms', () => {
    const user = createUser('search-and');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-and',
    });
    chat(net!.id, '#a', 'alice', 'release deadline friday');
    chat(net!.id, '#a', 'bob', 'deadline only');

    const hits = searchMessages(user.id, { query: 'release deadline' });
    expect(hits.map((m) => m.text)).toEqual(['release deadline friday']);
  });

  it('filters by nick (from:)', () => {
    const user = createUser('search-nick');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-nick',
    });
    chat(net!.id, '#a', 'alice', 'hello world');
    chat(net!.id, '#a', 'bob', 'hello world');

    const hits = searchMessages(user.id, { query: 'hello', nick: 'ALICE' });
    expect(hits.map((m) => m.nick)).toEqual(['alice']);
  });

  it('filters by target (in:)', () => {
    const user = createUser('search-target');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-target',
    });
    chat(net!.id, '#a', 'alice', 'ping');
    chat(net!.id, '#b', 'alice', 'ping');

    const hits = searchMessages(user.id, { query: 'ping', target: '#A' });
    expect(hits.map((m) => m.target)).toEqual(['#a']);
  });

  it('unscoped in: folds per network, not with one legacy fold (#707)', async () => {
    // On an rfc1459 network '#chat[dev]' is stored under fold '#chat{dev}'.
    // The unscoped search used to bind ONE legacy-folded string, which
    // matches no per-network fold — zero results that look like missing data.
    const user = createUser('search-refold');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-refold',
    });
    chat(net!.id, '#chat[dev]', 'alice', 'deploy went fine');
    const { refoldNetworkBuffers } = await import('./refoldBuffers.js');
    refoldNetworkBuffers(user.id, net!.id, 'rfc1459');

    // Either bracket spelling finds it, with and without the network scope.
    expect(searchMessages(user.id, { query: 'deploy', target: '#chat[dev]' })).toHaveLength(1);
    expect(searchMessages(user.id, { query: 'deploy', target: '#chat{dev}' })).toHaveLength(1);
    expect(
      searchMessages(user.id, { query: 'deploy', target: '#chat[dev]', networkId: net!.id }),
    ).toHaveLength(1);
  });

  it('filters by networkId (on:)', () => {
    const user = createUser('search-network');
    const netA = createNetwork(user.id, {
      name: 'a',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-network',
    });
    const netB = createNetwork(user.id, {
      name: 'b',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-network',
    });
    chat(netA!.id, '#a', 'alice', 'shared word');
    chat(netB!.id, '#a', 'alice', 'shared word');

    const hits = searchMessages(user.id, { query: 'shared', networkId: netB!.id });
    expect(hits.map((m) => m.networkId)).toEqual([netB!.id]);
  });

  it('supports a structured-only query with no free text', () => {
    const user = createUser('search-structured');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-structured',
    });
    chat(net!.id, '#a', 'alice', 'first');
    chat(net!.id, '#a', 'alice', 'second');
    chat(net!.id, '#a', 'bob', 'third');

    const hits = searchMessages(user.id, { nick: 'alice' });
    expect(hits.map((m) => m.text).toSorted()).toEqual(['first', 'second']);
  });

  it('OR-matches several nicks via `nicks`, case-insensitively', () => {
    const user = createUser('search-nicks');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-nicks',
    });
    chat(net!.id, '#a', 'eren', 'one');
    chat(net!.id, '#a', 'nostimo', 'two');
    chat(net!.id, '#a', 'twomoon', 'three');
    chat(net!.id, '#a', 'stranger', 'four');

    const hits = searchMessages(user.id, { nicks: ['EREN', 'nostimo'] });
    expect(hits.map((m) => m.text).toSorted()).toEqual(['one', 'two']);
  });

  it('returns nothing when there is no free text and no filter', () => {
    const user = createUser('search-empty');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-empty',
    });
    chat(net!.id, '#a', 'alice', 'something');
    expect(searchMessages(user.id, { query: '   ' })).toEqual([]);
  });

  it('excludes non-chat event types', () => {
    const user = createUser('search-types');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-types',
    });
    chat(net!.id, '#a', 'alice', 'topic about widgets');
    insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'topic',
      nick: 'alice',
      text: 'widgets channel topic',
      self: false,
    });

    const hits = searchMessages(user.id, { query: 'widgets' });
    expect(hits.map((m) => m.type)).toEqual(['message']);
  });

  it("never returns another user's messages", () => {
    const userA = createUser('search-iso-a');
    const userB = createUser('search-iso-b');
    const netA = createNetwork(userA.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-iso-a',
    });
    const netB = createNetwork(userB.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-iso-b',
    });
    chat(netA!.id, '#a', 'alice', 'secret keyword apple');
    chat(netB!.id, '#a', 'bob', 'secret keyword apple');

    const hitsA = searchMessages(userA.id, { query: 'apple' });
    expect(hitsA.map((m) => m.networkId)).toEqual([netA!.id]);
    // Even an explicit networkId for a network they don't own returns nothing.
    expect(searchMessages(userA.id, { query: 'apple', networkId: netB!.id })).toEqual([]);
  });

  it('paginates newest-first via the before cursor', () => {
    const user = createUser('search-page');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-page',
    });
    for (let i = 1; i <= 5; i += 1) chat(net!.id, '#a', 'alice', `page item ${i}`);

    const firstPage = searchMessages(user.id, { query: 'item', limit: 2 });
    expect(firstPage.map((m) => m.text)).toEqual(['page item 5', 'page item 4']);

    const secondPage = searchMessages(user.id, {
      query: 'item',
      limit: 2,
      before: firstPage[firstPage.length - 1].id,
    });
    expect(secondPage.map((m) => m.text)).toEqual(['page item 3', 'page item 2']);
  });

  it('includes the network name on each result', () => {
    const user = createUser('search-netname');
    const net = createNetwork(user.id, {
      name: 'OFTC',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-netname',
    });
    chat(net!.id, '#a', 'alice', 'banana split');
    const hits = searchMessages(user.id, { query: 'banana' });
    expect(hits[0].networkName).toBe('OFTC');
  });

  it('excludes from_ignored senders', () => {
    const user = createUser('search-ignored');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-ignored',
    });
    chat(net!.id, '#a', 'alice', 'shared keyword here');
    insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'spammer',
      text: 'shared keyword here',
      self: false,
      fromIgnored: true,
    });

    // Free-text search skips the ignored row...
    expect(searchMessages(user.id, { query: 'keyword' }).map((m) => m.nick)).toEqual(['alice']);
    // ...and so does a structured-only filter (no FTS join).
    expect(searchMessages(user.id, { target: '#a' }).map((m) => m.nick)).toEqual(['alice']);
  });

  // The driving-filter construction (SEARCH_FILTER_INDEX_PLAN in lurker-dev)
  // adds planner-steering predicates — a pushed-down network-id IN list, a
  // `+`-demoted buffer term — that are supposed to be semantically invisible.
  // These tests pin the semantics; messagesEqp.test.ts pins the plans.
  it('a filter-only nick search never crosses the tenant boundary', () => {
    // Two users, same nick speaking on each of their networks. The pushed-down
    // network-id list must be the CALLER'S networks, so each user sees only
    // their own copy.
    const userA = createUser('search-tenant-a');
    const userB = createUser('search-tenant-b');
    const netA = createNetwork(userA.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-tenant-a',
    });
    const netB = createNetwork(userB.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-tenant-b',
    });
    chat(netA!.id, '#a', 'shadow', 'message on network A');
    chat(netB!.id, '#b', 'shadow', 'message on network B');

    expect(searchMessages(userA.id, { nick: 'shadow' }).map((m) => m.text)).toEqual([
      'message on network A',
    ]);
    expect(searchMessages(userB.id, { nick: 'shadow' }).map((m) => m.text)).toEqual([
      'message on network B',
    ]);
  });

  it('from:+in: honors the buffer filter (the + demotion demotes, not drops)', () => {
    const user = createUser('search-nick-buf');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-nick-buf',
    });
    chat(net!.id, '#x', 'alice', 'said in x');
    chat(net!.id, '#y', 'alice', 'said in y');
    chat(net!.id, '#x', 'bob', 'also in x');

    expect(searchMessages(user.id, { nick: 'alice', target: '#x' }).map((m) => m.text)).toEqual([
      'said in x',
    ]);
    expect(
      searchMessages(user.id, { nick: 'alice', target: '#x', networkId: net!.id }).map(
        (m) => m.text,
      ),
    ).toEqual(['said in x']);
  });

  it('filter-only searches order newest-first and paginate via before', () => {
    const user = createUser('search-filter-page');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-filter-page',
    });
    for (let i = 1; i <= 5; i += 1) chat(net!.id, '#a', 'alice', `note ${i}`);
    chat(net!.id, '#a', 'bob', 'interleaved');

    const firstPage = searchMessages(user.id, { nick: 'alice', limit: 2 });
    expect(firstPage.map((m) => m.text)).toEqual(['note 5', 'note 4']);
    const secondPage = searchMessages(user.id, {
      nick: 'alice',
      limit: 2,
      before: firstPage[firstPage.length - 1].id,
    });
    expect(secondPage.map((m) => m.text)).toEqual(['note 3', 'note 2']);
  });
});

describe('searchMessages matched (highlights)', () => {
  function hl(networkId: number, nick: string, text: string, matched: number | null) {
    return insertMessage({
      networkId,
      target: '#hl',
      time: new Date().toISOString(),
      type: 'message',
      nick,
      text,
      self: false,
      matchedRuleId: matched,
    });
  }

  it('returns only matched rows, and all of them with no other filter', () => {
    const user = createUser('hl-matched');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'hl-matched',
    })!;
    hl(net.id, 'alice', 'a highlight', 7);
    hl(net.id, 'bob', 'not a highlight', null);
    hl(net.id, 'carol', 'another highlight', 9);

    const hits = searchMessages(user.id, { matched: true });
    expect(hits.map((m) => m.nick).toSorted()).toEqual(['alice', 'carol']);
  });

  it('combines matched with free text and from:/in: filters', () => {
    const user = createUser('hl-matched-filter');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'hl-matched-filter',
    })!;
    hl(net.id, 'alice', 'deploy finished', 7);
    hl(net.id, 'bob', 'deploy finished', 7);
    hl(net.id, 'alice', 'lunch plans', 7);

    expect(searchMessages(user.id, { matched: true, nick: 'alice' }).map((m) => m.text)).toEqual([
      'lunch plans',
      'deploy finished',
    ]);
    expect(
      searchMessages(user.id, { matched: true, query: 'deploy', nick: 'alice' }).map((m) => m.text),
    ).toEqual(['deploy finished']);
  });
});

describe('listMessagesAround', () => {
  it('centers a slice on the anchor with hasMore=false when total fits in halfLimit', () => {
    const user = createUser('around-fits');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-fits',
    });
    const ids = [];
    for (let i = 1; i <= 101; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[50]; // 51st insert, 50 older + 50 newer

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events.length).toBe(101);
    expect(slice.events[50].id).toBe(anchorId);
    expect(slice.hasMoreOlder).toBe(false);
    expect(slice.hasMoreNewer).toBe(false);
  });

  it('truncates to halfLimit on each side with both hasMore flags true', () => {
    const user = createUser('around-trunc');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-trunc',
    });
    const ids = [];
    for (let i = 1; i <= 1001; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[500];

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events.length).toBe(201);
    expect(slice.events[100].id).toBe(anchorId);
    expect(slice.hasMoreOlder).toBe(true);
    expect(slice.hasMoreNewer).toBe(true);
  });

  it('returns hasMoreOlder=false when the anchor is the oldest message', () => {
    const user = createUser('around-top');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-top',
    });
    const ids = [];
    for (let i = 1; i <= 100; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[0];

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events[0].id).toBe(anchorId);
    expect(slice.events.length).toBe(100); // 0 older + anchor + 99 newer
    expect(slice.hasMoreOlder).toBe(false);
    expect(slice.hasMoreNewer).toBe(false);
  });

  it('returns anchorMissing when the id does not exist in the buffer', () => {
    const user = createUser('around-missing');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-missing',
    });
    chat(net!.id, '#a', 'alice', 'one');

    const slice = listMessagesAround(net!.id, '#a', 9999999, 100);
    expect((slice as { anchorMissing?: boolean }).anchorMissing).toBe(true);
    expect(slice.events).toEqual([]);
  });

  it('refuses to lift a row out of a buffer the caller did not name', () => {
    // Anchor exists in #a but the caller asks for it scoped to #b. The
    // (network_id, target) guard on the anchor lookup is the access boundary
    // here — without it, knowing any message id would expose its content via
    // jump-to-message regardless of which buffer was queried.
    const user = createUser('around-scope');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-scope',
    });
    const aId = chat(net!.id, '#a', 'alice', 'private').id;
    chat(net!.id, '#b', 'bob', 'unrelated');

    const slice = listMessagesAround(net!.id, '#b', aId, 100);
    expect((slice as { anchorMissing?: boolean }).anchorMissing).toBe(true);
  });
});

describe('messages.alt parity (insert result)', () => {
  it('returns alt on the insert result', () => {
    const user = createUser('parity-return');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-return',
    });
    const first = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'hi',
      self: false,
    });
    const second = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'hi',
      self: false,
    });
    const sysEvt = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'join',
      nick: 'carol',
      self: false,
    });
    expect(first.alt).toBe(false);
    expect(second.alt).toBe(true);
    expect(sysEvt.alt).toBe(false);
  });
});

describe('messages.msgid (#450)', () => {
  it('round-trips through insertMessage → listMessages; absent when the row has none', () => {
    const user = createUser('msgid-roundtrip');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'msgid-roundtrip',
    });
    insertMessage({
      networkId: net!.id,
      target: '#m',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'tagged',
      self: false,
      msgid: 'abc-123',
    });
    insertMessage({
      networkId: net!.id,
      target: '#m',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'untagged',
      self: false,
    });
    const [tagged, untagged] = listMessages(net!.id, '#m');
    expect(tagged.msgid).toBe('abc-123');
    // Absent, not null — untagged backlogs must not grow a msgid field.
    expect(untagged).not.toHaveProperty('msgid');
  });

  it('coerces an empty-string msgid to NULL so it is never stored or indexed', () => {
    const user = createUser('msgid-empty');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'msgid-empty',
    });
    insertMessage({
      networkId: net!.id,
      target: '#m',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'empty tag',
      self: false,
      msgid: '',
    });
    expect(listMessages(net!.id, '#m')[0]).not.toHaveProperty('msgid');
  });
});

describe('from_ignored excludes ignored senders from unread/highlight counts', () => {
  function chatWith(
    networkId: number,
    opts: { nick: string; matched?: number; ignored?: boolean },
  ) {
    return insertMessage({
      networkId,
      target: '#ig',
      time: new Date().toISOString(),
      type: 'message',
      nick: opts.nick,
      text: 'hello',
      self: false,
      matchedRuleId: opts.matched ?? null,
      fromIgnored: opts.ignored === true,
    });
  }

  it('countNewer excludes from_ignored rows', () => {
    const user = createUser('ig-count');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice' });
    chatWith(net.id, { nick: 'spammer', ignored: true });
    chatWith(net.id, { nick: 'bob' });
    expect(countNewer(net.id, '#ig', 0)).toBe(2);
  });

  it('countNewer stops at the cap (exact below it) so a deep unread range is not scanned', () => {
    const user = createUser('cap-count');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    for (let i = 0; i < 5; i++) chat(net.id, '#cap', 'alice', `m${i}`);
    // Below the cap → exact.
    expect(countNewer(net.id, '#cap', 0)).toBe(5);
    // At/over the cap → returns the cap, not the true count (the client renders
    // both as ">999", so it's invisible; the point is the scan stops early).
    expect(countNewer(net.id, '#cap', 0, 3)).toBe(3);
    // Guard: a non-positive cap must NOT become SQLite's `LIMIT -1` (unbounded) —
    // it falls back to the default, so the count is still bounded (here, all 5).
    expect(countNewer(net.id, '#cap', 0, -1)).toBe(5);
    expect(countNewer(net.id, '#cap', 0, 0)).toBe(5);
  });

  it('countHighlightsNewer excludes from_ignored rows even when they matched a rule', () => {
    const user = createUser('ig-hl-count');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice', matched: 7 });
    chatWith(net.id, { nick: 'spammer', matched: 7, ignored: true });
    chatWith(net.id, { nick: 'bob', matched: 7 });
    expect(countHighlightsNewer(net.id, '#ig', 0)).toBe(2);
  });

  it('listUserHighlights hides from_ignored rows', () => {
    const user = createUser('ig-hl-list');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice', matched: 7 });
    chatWith(net.id, { nick: 'spammer', matched: 7, ignored: true });
    const items = listUserHighlights(user.id);
    expect(items.map((r) => r.nick)).toEqual(['alice']);
  });

  it('fromIgnored round-trips through rowToEvent', () => {
    const user = createUser('ig-roundtrip');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice' });
    chatWith(net.id, { nick: 'spammer', ignored: true });
    const rows = listMessages(net.id, '#ig', { limit: 50 });
    expect(rows.map((r) => ({ nick: r.nick, fromIgnored: r.fromIgnored }))).toEqual([
      { nick: 'alice', fromIgnored: false },
      { nick: 'spammer', fromIgnored: true },
    ]);
  });
});

describe('maxIdForBuffer', () => {
  it('returns 0 for a buffer with no rows', () => {
    const user = createUser('mfb-empty');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    expect(maxIdForBuffer(net.id, '#nope')).toBe(0);
  });

  it('returns the largest id in the buffer, ignoring other targets and networks', () => {
    const user = createUser('mfb-multi');
    const net1 = createNetwork(user.id, {
      name: 'n1',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    const net2 = createNetwork(user.id, {
      name: 'n2',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chat(net1.id, '#a', 'alice', 'a1');
    const a2 = chat(net1.id, '#a', 'alice', 'a2');
    chat(net1.id, '#b', 'bob', 'b1');
    chat(net2.id, '#a', 'eve', 'e1');
    expect(maxIdForBuffer(net1.id, '#a')).toBe(a2.id);
  });
});

describe('chathistory window queries', () => {
  // Insert a message at a controlled ISO time so the timestamp resolvers are
  // deterministic; ids stay monotonic in insertion order.
  function at(networkId: number, target: string, iso: string, text: string) {
    return Number(
      insertMessage({ networkId, target, time: iso, type: 'message', nick: 'n', text, self: false })
        .id,
    );
  }

  function evt(networkId: number, target: string, iso: string, type: string) {
    return Number(insertMessage({ networkId, target, time: iso, type, nick: 'x', self: false }).id);
  }

  it('loadHistoryWindow applies exclusive time bounds and returns oldest-first', () => {
    const user = createUser(`cw_${Math.random().toString(36).slice(2)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    const ids = [1, 2, 3, 4, 5].map((n) =>
      at(net.id, '#w', `2023-05-23T06:00:0${n}.000Z`, `m${n}`),
    );
    // upper bound (BEFORE): strictly earlier than :03, newest-first cap → oldest-first out.
    const before = loadHistoryWindow(net.id, '#w', null, '2023-05-23T06:00:03.000Z', 100, {
      newestFirst: true,
    });
    expect(before.map((m) => m.id)).toEqual([ids[0], ids[1]]);
    // lower bound (AFTER): strictly later than :02, earliest-first.
    const after = loadHistoryWindow(net.id, '#w', '2023-05-23T06:00:02.000Z', null, 100);
    expect(after.map((m) => m.id)).toEqual([ids[2], ids[3], ids[4]]);
    // newestFirst caps from the recent end but still returns oldest-first.
    const latest2 = loadHistoryWindow(net.id, '#w', null, null, 2, { newestFirst: true });
    expect(latest2.map((m) => m.id)).toEqual([ids[3], ids[4]]);
  });

  it('loadHistoryWindow orders/selects by time even when id order diverges', () => {
    const user = createUser(`cw_${Math.random().toString(36).slice(2)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    // Insert out of chronological order (a chained/ZNC upstream replaying old
    // buffered messages as live lines): the OLD-time row gets the highest id.
    at(net.id, '#o', '2023-05-23T06:00:02.000Z', 'newer');
    const oldId = at(net.id, '#o', '2023-05-23T06:00:01.000Z', 'older'); // higher id, older time
    // LATEST must return them oldest-first BY TIME, not by id.
    const latest = loadHistoryWindow(net.id, '#o', null, null, 10, { newestFirst: true });
    expect(latest.map((m) => m.text)).toEqual(['older', 'newer']);
    // BEFORE :02 selects the older-time row (id-ordering would have missed it).
    const before = loadHistoryWindow(net.id, '#o', null, '2023-05-23T06:00:02.000Z', 10, {
      newestFirst: true,
    });
    expect(before.map((m) => m.id)).toEqual([oldId]);
  });

  it('loadHistoryWindow excludes non-message rows so limit counts real messages', () => {
    const user = createUser(`cw_${Math.random().toString(36).slice(2)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    const m1 = at(net.id, '#n', '2023-05-23T06:00:01.000Z', 'hello');
    // A flood of joins/quits after the message must not fill the window.
    for (let i = 2; i <= 9; i++) evt(net.id, '#n', `2023-05-23T06:00:0${i}.000Z`, 'join');
    const rows = loadHistoryWindow(net.id, '#n', null, null, 3, { newestFirst: true });
    expect(rows.map((r) => r.id)).toEqual([m1]); // the joins are skipped, not counted
  });

  it('listActiveTargetsInWindow returns buffers active in the window, newest first', () => {
    const user = createUser(`cw_${Math.random().toString(36).slice(2)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    at(net.id, '#old', '2023-05-20T00:00:00.000Z', 'old');
    at(net.id, '#a', '2023-05-23T06:00:00.000Z', 'a');
    at(net.id, '#b', '2023-05-23T07:00:00.000Z', 'b');
    at(net.id, ':server:x', '2023-05-23T06:30:00.000Z', 'srv'); // excluded (pseudo-buffer)
    evt(net.id, '#joinonly', '2023-05-23T06:45:00.000Z', 'join'); // excluded (no real message)
    const targets = listActiveTargetsInWindow(
      net.id,
      '2023-05-23T00:00:00.000Z',
      '2023-05-24T00:00:00.000Z',
      100,
    );
    expect(targets.map((t) => t.target)).toEqual(['#b', '#a']); // #old outside window; :server:/#joinonly excluded
  });
});

// A page sized in the unit the reader perceives (WS_PROTOCOL_FIXES #10). The
// property under test throughout is the one that makes it safe to do at the
// server: the result is a CONTIGUOUS id range, exactly like a listMessages
// slice, so it can never open a hole in the client's scrollback.
describe("listMessagesCounted unit: 'renderable'", () => {
  function netFor(name: string): number {
    const user = createUser(name);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: name })!.id;
  }

  /** Every id in the buffer between the slice's ends, in order. */
  function idRange(networkId: number, target: string, from: number, to: number): number[] {
    return listMessages(networkId, target, { limit: 10_000 })
      .map((e) => e.id)
      .filter((id) => id >= from && id <= to);
  }

  /** Assert the slice is a gapless run of the buffer's ids. */
  function expectContiguous(rows: Array<{ id: number }>, networkId: number, target: string): void {
    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(idRange(networkId, target, ids[0], ids[ids.length - 1]));
  }

  it('fills the page with renderable rows where an event-counted page would not', () => {
    const net = netFor('rend-fill');
    // 20 messages, each buried under a netsplit's worth of presence churn — the
    // shape that made the client fetch, fold to nothing, and fetch again.
    for (let i = 1; i <= 20; i += 1) {
      for (let j = 0; j < 30; j += 1) event(net, '#a', 'join', `n${j}`);
      chat(net, '#a', 'alice', `m${i}`);
    }

    const eventCounted = listMessages(net, '#a', { limit: 10 });
    const renderable = listMessagesCounted(net, '#a', 'renderable', { limit: 10 });

    // Today's page: ten rows, nine of them noise that folds into one line.
    expect(eventCounted).toHaveLength(10);
    expect(eventCounted.filter((e) => e.type === 'message')).toHaveLength(1);
    // The new page: ten actual messages, with their runs along for the ride.
    expect(renderable.filter((e) => e.type === 'message')).toHaveLength(10);
    expectContiguous(renderable, net, '#a');
  });

  it('stops ON the limit-th renderable row, leaving its run to the next page', () => {
    const net = netFor('rend-boundary');
    for (let i = 1; i <= 5; i += 1) {
      for (let j = 0; j < 4; j += 1) event(net, '#a', 'part', `n${j}`);
      chat(net, '#a', 'alice', `m${i}`);
    }
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 2 });
    // Oldest row is the boundary message itself, not the joins that precede it:
    // the next page picks that run up whole, so consolidation summarizes it once
    // rather than splitting it across two pages.
    expect(rows[0].type).toBe('message');
    expect(rows[0].text).toBe('m4');
    expect(rows.filter((e) => e.type === 'message').map((e) => e.text)).toEqual(['m4', 'm5']);
  });

  it('pages backward through `before` without a gap or an overlap', () => {
    const net = netFor('rend-page');
    for (let i = 1; i <= 12; i += 1) {
      for (let j = 0; j < 3; j += 1) event(net, '#a', 'quit', `n${j}`);
      chat(net, '#a', 'alice', `m${i}`);
    }
    const page1 = listMessagesCounted(net, '#a', 'renderable', { limit: 4 });
    const page2 = listMessagesCounted(net, '#a', 'renderable', { limit: 4, before: page1[0].id });
    expect(page1.filter((e) => e.type === 'message').map((e) => e.text)).toEqual([
      'm9',
      'm10',
      'm11',
      'm12',
    ]);
    expect(page2.filter((e) => e.type === 'message').map((e) => e.text)).toEqual([
      'm5',
      'm6',
      'm7',
      'm8',
    ]);
    // Joined end to end, the two pages are still one gapless run — the paging
    // cursor is unchanged from the event-counted case (`before: oldest id`).
    expectContiguous([...page2, ...page1], net, '#a');
    expect(page2[page2.length - 1].id).toBeLessThan(page1[0].id);
  });

  it('pages forward through `afterId`, exclusive of the cursor', () => {
    const net = netFor('rend-after');
    const ids: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      for (let j = 0; j < 3; j += 1) event(net, '#a', 'join', `n${j}`);
      ids.push(chat(net, '#a', 'alice', `m${i}`).id);
    }
    const rows = listMessagesCounted(net, '#a', 'renderable', { afterId: ids[2], limit: 3 });
    expect(rows.every((r) => r.id > ids[2])).toBe(true);
    expect(rows.filter((e) => e.type === 'message').map((e) => e.text)).toEqual(['m4', 'm5', 'm6']);
    expectContiguous(rows, net, '#a');
  });

  it('returns the whole buffer when it holds fewer renderable rows than the limit', () => {
    const net = netFor('rend-short');
    for (let j = 0; j < 8; j += 1) event(net, '#a', 'join', `n${j}`);
    chat(net, '#a', 'alice', 'only one');
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 100 });
    expect(rows).toHaveLength(9);
    expect(rows.filter((e) => e.type === 'message')).toHaveLength(1);
  });

  it('returns an all-noise buffer rather than an empty page', () => {
    // No renderable row exists to spend the budget on. Returning [] here would
    // read to a client as "start of history" and stop its pager dead.
    const net = netFor('rend-allnoise');
    for (let j = 0; j < 40; j += 1) event(net, '#a', 'join', `n${j}`);
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 100 });
    expect(rows).toHaveLength(40);
  });

  it('returns an empty page for a buffer with nothing in it', () => {
    const net = netFor('rend-empty');
    expect(listMessagesCounted(net, '#nothing', 'renderable', { limit: 100 })).toEqual([]);
  });

  it('bounds the scan (and so the payload) at maxScan', () => {
    // The whole safety story: a netsplit can put tens of thousands of joins
    // between two sentences. Past the cap the page ships fewer renderable rows
    // than asked and the caller's hasMoreOlder stays true — the pathological
    // buffer degrades to today's behavior instead of a 50 MB frame.
    const net = netFor('rend-cap');
    for (let j = 0; j < 300; j += 1) event(net, '#a', 'join', `n${j}`);
    chat(net, '#a', 'alice', 'the one message');
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 50, maxScan: 100 });
    expect(rows).toHaveLength(100);
    expect(rows.filter((e) => e.type === 'message')).toHaveLength(1);
    expectContiguous(rows, net, '#a');
    // Still contiguous with the tail, so the next page's cursor is valid.
    expect(rows[rows.length - 1].text).toBe('the one message');
  });

  it('spends the budget on standalone lines that consolidation deliberately excludes', () => {
    // kick/mode/topic each render as their own line — counting only
    // message/action/notice would under-fill a buffer whose traffic is those.
    const net = netFor('rend-standalone');
    for (const type of ['kick', 'mode', 'topic', 'kick', 'mode']) {
      event(net, '#a', type, 'alice');
    }
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type)).toEqual(['kick', 'mode']);
  });

  it('treats every type shared/consolidate folds — and only those — as free', () => {
    // Drift guard: the server must fold on the EXACT set the clients fold on,
    // or a page is sized in a unit nobody renders.
    const net = netFor('rend-types');
    for (const type of CONSOLIDATABLE_TYPES) event(net, '#a', type, 'alice');
    const noiseCount = CONSOLIDATABLE_TYPES.size;
    chat(net, '#a', 'alice', 'the only renderable row');

    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('the only renderable row');
    // ...and asking for two pulls in the whole noise run behind it.
    expect(listMessagesCounted(net, '#a', 'renderable', { limit: 2 })).toHaveLength(noiseCount + 1);
  });
});

describe("listMessagesCounted unit: 'chat' (#666)", () => {
  function netFor(name: string): number {
    const user = createUser(name);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: name })!.id;
  }

  it("delegates to the plain pager at unit 'event'", () => {
    // 'event' has no scan pass to do — every stored row counts — so it must be
    // indistinguishable from listMessages, cursor semantics included.
    const net = netFor('unit-event');
    for (let i = 1; i <= 6; i += 1) chat(net, '#a', 'alice', `m${i}`);
    expect(listMessagesCounted(net, '#a', 'event', { limit: 3 })).toEqual(
      listMessages(net, '#a', { limit: 3 }),
    );
  });

  it('excludes mode rows from the budget where renderable would spend it', () => {
    // The reason this unit exists: a reader on the `none` tier draws nothing for
    // a mode row, so counting it hands them a page that renders short. An op
    // handing out +v to a room is exactly the shape that produces this.
    const net = netFor('unit-chat-mode');
    for (let i = 1; i <= 10; i += 1) {
      for (let j = 0; j < 5; j += 1) event(net, '#a', 'mode', `n${j}`);
      chat(net, '#a', 'alice', `m${i}`);
    }

    const renderable = listMessagesCounted(net, '#a', 'renderable', { limit: 6 });
    const chatUnit = listMessagesCounted(net, '#a', 'chat', { limit: 6 });

    // 'renderable' counts modes as their own line, so six slots buy one message.
    expect(renderable.filter((e) => e.type === 'message')).toHaveLength(1);
    // 'chat' spends all six on messages.
    expect(chatUnit.filter((e) => e.type === 'message')).toHaveLength(6);
  });

  it('stops spending `renderable` budget on op churn that folds away (#673)', () => {
    // The regression this guards: a netsplit rejoin on an auto-op channel is one
    // ChanServ `+o` per join, and a folding client draws the whole run as ONE
    // summary line. While those rows still counted, a `limit`-unit page could be
    // satisfied entirely by rows that render as nothing — the short-page loop
    // that `renderable` exists to prevent.
    const net = netFor('unit-renderable-modefold');
    for (let i = 1; i <= 10; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        modeEvent(net, '#a', [{ mode: '+o', param: `n${j}`, kind: 'prefix' }]);
      }
      chat(net, '#a', 'alice', `m${i}`);
    }

    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 6 });
    expect(rows.filter((e) => e.type === 'message')).toHaveLength(6);
  });

  it('still spends `renderable` budget on mode rows that stand alone', () => {
    // Bans, channel flags, mixed messages and unstamped backlog never fold, so
    // making them free would push the unit the other way and over-fetch.
    const net = netFor('unit-renderable-modestand');
    for (let i = 1; i <= 3; i += 1) {
      modeEvent(net, '#a', [{ mode: '+b', param: '*!*@host', kind: 'list' }]);
      modeEvent(net, '#a', [
        { mode: '+o', param: 'alice', kind: 'prefix' },
        { mode: '-b', param: '*!*@host', kind: 'list' },
      ]);
      modeEvent(net, '#a', [{ mode: '+o', param: 'alice' }]);
      chat(net, '#a', 'alice', `m${i}`);
    }
    const rows = listMessagesCounted(net, '#a', 'renderable', { limit: 4 });
    // Four slots buy the three standalone mode rows plus one message, not four
    // messages.
    expect(rows.filter((e) => e.type === 'message')).toHaveLength(1);
    expect(rows.filter((e) => e.type === 'mode')).toHaveLength(3);
  });

  it('still spends the budget on kicks, topics and invites', () => {
    // The `none` tier hides churn, not events that carry information. If these
    // were free the page would over-fetch on a buffer made mostly of them.
    const net = netFor('unit-chat-standalone');
    for (const type of ['kick', 'topic', 'invite', 'kick', 'topic']) {
      event(net, '#a', type, 'alice');
    }
    const rows = listMessagesCounted(net, '#a', 'chat', { limit: 2 });
    expect(rows.map((r) => r.type)).toEqual(['kick', 'topic']);
  });

  it('treats exactly NOISE_TYPES as free', () => {
    // Drift guard, matching the renderable one above: the server must size the
    // page in the same unit the client renders, or the whole exercise is moot.
    const net = netFor('unit-chat-types');
    for (const type of NOISE_TYPES) event(net, '#a', type, 'alice');
    chat(net, '#a', 'alice', 'the only chat row');

    const rows = listMessagesCounted(net, '#a', 'chat', { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('the only chat row');
    expect(listMessagesCounted(net, '#a', 'chat', { limit: 2 })).toHaveLength(NOISE_TYPES.size + 1);
  });

  it('returns an all-noise buffer rather than an empty page', () => {
    // Same trap as the renderable case: [] reads to a client as "start of
    // history" and stops its pager dead.
    const net = netFor('unit-chat-allnoise');
    for (let j = 0; j < 12; j += 1) event(net, '#a', 'mode', `n${j}`);
    expect(listMessagesCounted(net, '#a', 'chat', { limit: 50 })).toHaveLength(12);
  });

  it('pages backward through `before` without a gap or an overlap', () => {
    const net = netFor('unit-chat-page');
    for (let i = 1; i <= 8; i += 1) {
      event(net, '#a', 'mode', 'op');
      event(net, '#a', 'join', `n${i}`);
      chat(net, '#a', 'alice', `m${i}`);
    }
    const page1 = listMessagesCounted(net, '#a', 'chat', { limit: 3 });
    const page2 = listMessagesCounted(net, '#a', 'chat', { limit: 3, before: page1[0].id });
    expect(page1.filter((e) => e.type === 'message').map((e) => e.text)).toEqual([
      'm6',
      'm7',
      'm8',
    ]);
    expect(page2.filter((e) => e.type === 'message').map((e) => e.text)).toEqual([
      'm3',
      'm4',
      'm5',
    ]);
  });
});

describe('listMessagesAround countBy', () => {
  it('sizes each side in renderable rows when asked', () => {
    // A jump is a hydrate for any client that enters a buffer with a pending
    // anchor (push tap, highlight, jump-to-first-unread), so an event-counted
    // window lands them on the same near-blank screen (#10).
    const user = createUser('around-renderable');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    const ids: number[] = [];
    for (let i = 1; i <= 20; i += 1) {
      for (let j = 0; j < 10; j += 1) event(net.id, '#a', 'join', `n${j}`);
      ids.push(chat(net.id, '#a', 'alice', `m${i}`).id);
    }
    const anchorId = ids[9]; // m10

    const eventCounted = listMessagesAround(net.id, '#a', anchorId, 11);
    const renderable = listMessagesAround(net.id, '#a', anchorId, 3, 'renderable');
    const texts = (s: {
      events: ReadonlyArray<{ type: string; text: string | null }>;
    }): unknown[] => s.events.filter((e) => e.type === 'message').map((e) => e.text);

    // 11 rows a side is one message either way — the churn ate the window.
    expect(texts(eventCounted)).toEqual(['m9', 'm10', 'm11']);
    // 3 renderable a side is three messages either way, anchor in the middle.
    expect(texts(renderable)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13']);
    expect(renderable.events.find((e) => e.id === anchorId)).toBeDefined();
    // Still one contiguous run, so the paging cursors either side stay valid.
    const rendIds = renderable.events.map((e) => e.id);
    expect(rendIds.at(-1)! - rendIds[0] + 1).toBe(rendIds.length);
  });
});

describe('hasMoreThan (#469 resume-gap probe)', () => {
  // The connect snapshot decides append-vs-replace on this one boolean, so its
  // boundary IS the protocol decision: one off-by-one silently flips a gap-fill
  // into a wholesale replace and throws away the client's scrollback.
  const setup = (name: string) => {
    const user = createUser(name);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: name,
    });
    return net!.id;
  };

  it('is exclusive at the boundary: exactly `count` rows is NOT more than `count`', () => {
    const net = setup('hmt-boundary');
    const since = chat(net, '#b', 'a', 'cursor').id;
    const ids = Array.from({ length: 10 }, (_, i) => chat(net, '#b', 'a', `m${i}`).id);
    expect(hasMoreThan(net, '#b', since, 10)).toBe(false); // exactly 10 after
    expect(hasMoreThan(net, '#b', since, 9)).toBe(true); // 10 > 9
    chat(net, '#b', 'a', 'one more');
    expect(hasMoreThan(net, '#b', since, 10)).toBe(true); // now 11
    // Anchored on the CURSOR, not on the buffer's size.
    expect(hasMoreThan(net, '#b', ids[4], 6)).toBe(false); // 6 rows after ids[4]
    expect(hasMoreThan(net, '#b', ids[4], 5)).toBe(true);
  });

  it('counts only THIS buffer, since message ids are a global sequence', () => {
    // The reason the probe uses OFFSET rather than id arithmetic. Interleaving a
    // second buffer inflates the id span without adding rows here, so any
    // `afterId + count` shortcut would report the gap as overflowed.
    const net = setup('hmt-global-ids');
    const since = chat(net, '#quiet', 'a', 'cursor').id;
    for (let i = 0; i < 50; i++) chat(net, '#loud', 'a', `noise${i}`);
    chat(net, '#quiet', 'a', 'only one more');
    expect(hasMoreThan(net, '#quiet', since, 1)).toBe(false);
    expect(hasMoreThan(net, '#quiet', since, 0)).toBe(true);
    expect(hasMoreThan(net, '#loud', since, 49)).toBe(true);
    expect(hasMoreThan(net, '#loud', since, 50)).toBe(false);
  });

  it('handles an empty gap, an unknown buffer, and a cursor past the tail', () => {
    const net = setup('hmt-edges');
    const tail = chat(net, '#e', 'a', 'only').id;
    expect(hasMoreThan(net, '#e', tail, 0)).toBe(false); // nothing after the tail
    expect(hasMoreThan(net, '#e', 0, 0)).toBe(true); // one row from the start
    expect(hasMoreThan(net, '#e', tail + 1000, 0)).toBe(false); // cursor past the end
    expect(hasMoreThan(net, '#nope', 0, 0)).toBe(false); // no such buffer
  });

  it('agrees with the read-then-measure test it replaced', () => {
    // The probe exists to avoid READING the gap, so pin it against the thing it
    // replaced: "the capped read filled up AND another row exists past its last".
    // Any divergence here is a behaviour change wearing a performance label.
    const net = setup('hmt-oracle');
    const since = chat(net, '#o', 'a', 'cursor').id;
    const CAP = 8;
    for (let n = 0; n <= 12; n++) {
      if (n > 0) chat(net, '#o', 'a', `m${n}`);
      const gap = listMessages(net, '#o', { afterId: since, limit: CAP });
      const lastGapId = gap.length ? gap[gap.length - 1].id : since;
      const oracle =
        gap.length >= CAP && listMessages(net, '#o', { afterId: lastGapId, limit: 1 }).length > 0;
      expect(hasMoreThan(net, '#o', since, CAP)).toBe(oracle);
    }
  });
});
