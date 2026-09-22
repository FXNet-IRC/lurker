// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC CHAT wiring (#270): the glue between a CTCP `DCC CHAT` offer and a live
// session on IrcConnection. The wire grammar is unit-pinned in dcc.test.ts and
// the socket engine in dccChat.test.ts; these exercise the PLUMBING — does an
// offer become a session, does an offer we can't honour say so, and — the
// reason this feature needed a branch of its own — does a `=nick` target stay
// off the IRC wire on every path that could put it there.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import net from 'net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import db from '../db/index.js';
import { createNetwork } from '../db/networks.js';
import { createUser } from '../db/users.js';
import { CAPABILITY_DCC, setUserCapability } from '../db/userCapabilities.js';
import { encodeDccAddress } from './dcc.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { activeDccListenerCount, resetDccListeners } from './dccListener.js';
import { resetDccChatHosts } from './dccChatSessions.js';
import { ensureOpen, isClosed } from '../db/buffers.js';
import { closeBuffer } from './wsHub.js';

beforeAll(() => {
  createUser('dcc-chat-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

// ⚠⚠ Below 32768, deliberately. A fixed test port must sit OUTSIDE the OS
// ephemeral range, which the kernel hands out as the LOCAL port of every
// outgoing connection — any concurrent test's client socket can land on it,
// and this listen then fails with EADDRINUSE. Linux's range is 32768-60999
// and macOS's 49152-65535, so the old 458xx ports were safe on a Mac and
// collided under CI's parallel suite on Linux (reproduced in Docker, Node 24:
// EADDRINUSE 127.0.0.1:45822). Keep any replacement below 32768. Distinct from dccListener.test.ts's
// 24820-24829, since the two files can run in parallel.
const LISTEN_MIN = 24840;
const LISTEN_MAX = 24849;

const peers: net.Server[] = [];
afterEach(() => {
  delete process.env.LURKER_DCC_ENABLED;
  delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  delete process.env.LURKER_DCC_EXTERNAL_HOST;
  delete process.env.LURKER_DCC_LISTEN_BIND;
  delete process.env.LURKER_DCC_LISTEN_PORT_MIN;
  delete process.env.LURKER_DCC_LISTEN_PORT_MAX;
  setUserCapability(1, CAPABILITY_DCC, false);
  db.prepare('DELETE FROM messages').run();
  resetDccListeners();
  resetDccChatHosts();
  for (const p of peers.splice(0)) p.close();
  ircManager.byUser.delete(1);
});

function makeConn(networkFields: Record<string, unknown> = {}): IrcConnection {
  return new IrcConnection({
    network: {
      client_cert: null,
      client_key: null,
      proxy_enabled: 0,
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password: null,
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      casemapping: null,
      created_at: new Date().toISOString(),
      ...networkFields,
    },
    onEvent: () => {},
  });
}

// Spies are built fresh per test (never in a hook) so nothing depends on how
// vitest clears mocks between cases.
function harness() {
  const conn = makeConn();
  // A live IRC link by default: sending a DCC offer or reverse reply rides it,
  // and a connection in backoff now refuses rather than having irc-framework
  // silently drop the CTCP. Tests about a down link set this themselves.
  conn.state = 'connected';
  const ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const say = vi.fn<(target: string, text: string) => void>();
  const raw = vi.fn<(line: string) => void>();
  const published: Array<Record<string, unknown>> = [];
  const ephemeral: Array<Record<string, unknown>> = [];
  conn.client.ctcpRequest = ctcpRequest;
  conn.client.say = say;
  conn.raw = raw;
  conn.publish = (event: Record<string, unknown>) => {
    published.push(event);
    return undefined;
  };
  conn.publishEphemeral = (event: Record<string, unknown>) => {
    ephemeral.push(event);
  };
  // The body of the last outgoing CTCP DCC request: ctcpRequest(target,'DCC',body).
  const lastOffer = (): string | null => {
    const call = ctcpRequest.mock.calls.at(-1);
    return call ? call.slice(2).join(' ') : null;
  };
  const notices = () =>
    published.filter((e) => e.type === 'notice').map((e) => String(e.text ?? ''));
  // CTCP status lines are ephemeral and are where an unsolicited offer is
  // surfaced — deliberately not a persisted notice, which would mint a buffer.
  const ctcpLines = () =>
    ephemeral.filter((e) => e.type === 'ctcp').map((e) => String(e.text ?? ''));
  const stateEvents = () =>
    ephemeral
      .filter((e) => e.type === 'dcc-chat-state')
      .map((e) => ({ from: e.from, live: e.live }));
  const offerEvents = () =>
    ephemeral.filter(
      (e) => e.type === 'dcc-chat-offer' || e.type === 'dcc-chat-offer-closed',
    ) as Array<{ type: string; from: string; passive?: boolean }>;
  const chatLines = () =>
    published.filter((e) => e.type === 'message' && e.kind === 'dcc-chat') as Array<{
      text: string;
      self?: boolean;
      target: string;
    }>;
  return {
    conn,
    ctcpRequest,
    say,
    raw,
    published,
    lastOffer,
    notices,
    ctcpLines,
    offerEvents,
    stateEvents,
    chatLines,
  };
}

function enableDcc() {
  process.env.LURKER_DCC_ENABLED = '1';
  setUserCapability(1, CAPABILITY_DCC, true);
}

// Allow the SSRF guard to dial loopback, which every local peer here is.
function allowLoopback() {
  process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
}

function enableListening() {
  process.env.LURKER_DCC_EXTERNAL_HOST = '203.0.113.5';
  process.env.LURKER_DCC_LISTEN_BIND = '127.0.0.1';
  process.env.LURKER_DCC_LISTEN_PORT_MIN = String(LISTEN_MIN);
  process.env.LURKER_DCC_LISTEN_PORT_MAX = String(LISTEN_MAX);
}

// A peer that accepts one connection and hands back its socket.
function startPeer(): Promise<{ port: number; socket: Promise<net.Socket> }> {
  return new Promise((resolve) => {
    let onSock!: (s: net.Socket) => void;
    const socket = new Promise<net.Socket>((r) => {
      onSock = r;
    });
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      onSock(sock);
    });
    peers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as net.AddressInfo).port, socket });
    });
  });
}

// Put a connection where ircManager's send paths will find it, without opening
// a real IRC socket.
function inject(conn: IrcConnection): void {
  ircManager.byUser.set(1, new Map([[1, conn]]));
}

function offerFrom(conn: IrcConnection, nick: string, body: string): void {
  conn.client.emit('ctcp request', { nick, type: 'DCC', message: `DCC ${body}` });
}

// An inbound offer is never auto-accepted, so the flows below take it and then
// accept it the way the user would: `/dcc chat <nick>`.
function offerAndAccept(conn: IrcConnection, nick: string, body: string): void {
  offerFrom(conn, nick, body);
  conn.offerDccChat(nick);
}

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('inbound DCC CHAT offer', () => {
  it('dials an active offer and carries lines both ways', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();

    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    // Peer → us, split across packets to prove the framing is stream-safe.
    sock.write('hello ');
    sock.write('there\r\n');
    await waitFor(() => h.chatLines().length > 0);
    expect(h.chatLines()[0]).toMatchObject({ text: 'hello there', target: '=bob', self: false });

    // Us → peer, CRLF-framed.
    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    expect(h.conn.dccChatSend('bob', 'hi back')).toBe(true);
    expect(await got).toBe('hi back\r\n');
    expect(h.chatLines().at(-1)).toMatchObject({ text: 'hi back', self: true });

    h.conn.closeDccChat('bob');
  });

  it('accepts a bare-LF peer (irssi, HexChat and repartee all send one)', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    sock.write('bare lf line\n');
    await waitFor(() => h.chatLines().length > 0);
    expect(h.chatLines()[0].text).toBe('bare lf line');
    h.conn.closeDccChat('bob');
  });

  it('refuses a private address unless the operator opted in', async () => {
    enableDcc(); // note: no allowLoopback()
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    expect(h.conn.hasDccChat('bob')).toBe(false);
    expect(h.notices().at(-1)).toMatch(/private or reserved/);
  });

  // ⚠⚠ The shape that turns into a dial to port 0 in WeeChat. Assert
  // synchronously: a `waitFor` on "no session" would pass before any dial could
  // have happened and so could never fail.
  it('refuses a passive offer carrying no token, and does not dial', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} 0`);
    expect(h.conn.hasDccChat('bob')).toBe(false);
    // parseDcc rejects it outright, so it never reaches the chat handler at all
    // and no `=bob` buffer is conjured.
    expect(h.notices()).toHaveLength(0);
  });

  it('answers a peer passive offer by listening and replying with our port + their token', async () => {
    enableDcc();
    enableListening();
    const h = harness();

    offerAndAccept(h.conn, 'bob', 'CHAT chat 16843009 0 42');
    await waitFor(() => h.lastOffer() !== null);

    const body = h.lastOffer()!;
    const [subtype, proto, addr, portStr, token] = body.split(' ');
    expect(subtype).toBe('CHAT');
    expect(proto).toBe('chat');
    expect(addr).toBe(encodeDccAddress('203.0.113.5'));
    expect(Number(portStr)).toBeGreaterThanOrEqual(LISTEN_MIN);
    expect(Number(portStr)).toBeLessThanOrEqual(LISTEN_MAX);
    expect(token).toBe('42');

    // The peer dials the advertised port and the session opens.
    const client = net.connect({ host: '127.0.0.1', port: Number(portStr) });
    client.on('error', () => {});
    await waitFor(() => h.conn.hasDccChat('bob'));
    h.conn.closeDccChat('bob');
    client.destroy();
  });

  it('explains rather than hangs when a peer passive offer arrives with no listen range', () => {
    enableDcc();
    const h = harness();
    offerAndAccept(h.conn, 'bob', 'CHAT chat 16843009 0 42');
    expect(h.conn.hasDccChat('bob')).toBe(false);
    expect(h.notices().at(-1)).toMatch(/no listening port range/);
  });

  it('is inert when DCC is not enabled for the user', () => {
    const h = harness(); // gate left off
    allowLoopback();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
    expect(h.conn.hasDccChat('bob')).toBe(false);
    expect(h.notices()).toHaveLength(0);
  });
});

// ⚠⚠ An unsolicited offer must not make this server dial an address a stranger
// chose, nor hand them its IP, on nothing but a PRIVMSG. Both mature references
// agree: WeeChat's xfer.file.auto_accept_chats defaults to "off" ("use
// carefully!", xfer-config.c:333-338) and irssi's dcc_autochat_masks defaults to
// empty (dcc-chat.c:835), so neither accepts without the user saying so. Lurker's
// own file path already requires approval; chat must not be weaker.
describe('an inbound offer is not auto-accepted', () => {
  // `dialDccChat` publishes "Connecting to …" synchronously, before net.connect,
  // so its ABSENCE is a deterministic assertion that no dial was attempted —
  // no sleeping on "did a connection show up".
  const dialled = (h: ReturnType<typeof harness>) =>
    h.notices().some((t) => t.startsWith('Connecting to '));

  it('records the offer and asks, without dialling', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
    expect(h.conn.hasDccChat('bob')).toBe(false);
    expect(dialled(h)).toBe(false);
    expect(h.ctcpLines().at(-1)).toMatch(/wants to start a DCC chat/);
    expect(h.ctcpLines().at(-1)).toContain('/dcc chat bob');
    // ⚠ And no `=bob` buffer: an unsolicited offer must not put a row in the
    // sidebar. A persisted notice would have minted one.
    expect(h.published).toHaveLength(0);
  });

  it('says who would be doing the listening when the offer is passive', () => {
    enableDcc();
    enableListening();
    const h = harness();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 0 42');
    expect(h.ctcpRequest).not.toHaveBeenCalled(); // no reverse reply until accepted
    expect(h.ctcpLines().at(-1)).toMatch(/firewalled, so this server would listen/);
  });

  // `/dcc chat <nick>` doubles as accept, as it does in irssi — offering back at
  // someone already waiting on us would just deadlock the two halves.
  it('accepts via /dcc chat <nick> rather than making a counter-offer', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    expect(dialled(h)).toBe(false);

    h.conn.offerDccChat('bob');
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    // It dialled them; it did not send an offer of its own.
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    h.conn.closeDccChat('bob');
  });

  it('declines a pending offer via /dcc close <nick>', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
    expect(h.conn.closeDccChat('bob')).toBe(true);
    expect(h.ctcpLines().at(-1)).toMatch(/Declined the DCC chat offer/);
    // Declined means gone: a later accept must not resurrect it.
    h.conn.offerDccChat('bob');
    expect(dialled(h)).toBe(false);
  });

  it('expires a pending offer instead of leaving it acceptable forever', () => {
    vi.useFakeTimers();
    try {
      enableDcc();
      allowLoopback();
      const h = harness();
      offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
      vi.advanceTimersByTime(10 * 60_000 + 1000);
      expect(h.ctcpLines().at(-1)).toMatch(/expired/);
      h.conn.offerDccChat('bob');
      expect(dialled(h)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the peer's casing in its notices", () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    offerFrom(h.conn, 'BoB', 'CHAT chat 16843009 5000');
    expect(h.ctcpLines().at(-1)).toContain('BoB');
  });
});

describe('outgoing DCC CHAT offer', () => {
  it('sends exactly five wire tokens with a uint32 address', async () => {
    enableDcc();
    enableListening();
    const h = harness();

    h.conn.offerDccChat('bob');
    await waitFor(() => h.lastOffer() !== null);

    const call = h.ctcpRequest.mock.calls.at(-1)!;
    expect(call[0]).toBe('bob');
    expect(call[1]).toBe('DCC');
    const body = h.lastOffer()!;
    // `DCC` + body is what lands inside the \x01 framing.
    expect(`DCC ${body}`.split(' ')).toHaveLength(5);
    const [, proto, addr] = body.split(' ');
    expect(proto).toBe('chat'); // lowercase: the majority dialect
    expect(addr).toBe('3405803781'); // 203.0.113.5 as a network-order uint32
    expect(addr).not.toContain('.'); // ⚠ irssi would decode a dotted quad as 0.0.0.192
  });

  // Rather than silently falling back to a passive offer, which WeeChat and
  // HexDroid mishandle into a dial to port 0 with nothing shown to the user.
  it('refuses with an explanation when no listen range is configured', () => {
    enableDcc();
    const h = harness();
    h.conn.offerDccChat('bob');
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(h.notices().at(-1)).toMatch(/no public address and listening port range/);
  });

  it('sends a passive offer only when explicitly asked, with a literal 0 port', () => {
    enableDcc();
    const h = harness();
    h.conn.offerDccChat('bob', { passive: true });
    const body = h.lastOffer()!;
    const [subtype, proto, addr, portStr, token] = body.split(' ');
    expect([subtype, proto]).toEqual(['CHAT', 'chat']);
    expect(addr).toBe('16843009'); // 1.1.1.1, irssi's and repartee's placeholder
    // ⚠ irssi detects passive with a string compare against "0" — never padded.
    expect(portStr).toBe('0');
    expect(Number(token)).toBeGreaterThanOrEqual(0);
    expect(Number(token)).toBeLessThan(64);
    expect(h.notices().at(-1)).toMatch(/WeeChat and HexDroid do not/);
  });

  it('dials the peer when they answer our passive offer with their port', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();

    h.conn.offerDccChat('bob', { passive: true });
    const token = h.lastOffer()!.split(' ')[4];

    // The reply echoes our token with a real port.
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port} ${token}`);
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    expect(h.conn.hasDccChat('bob')).toBe(true);
    expect(h.notices().at(-1)).toMatch(/connected/);
    h.conn.closeDccChat('bob');
  });

  it('ignores a reply whose token we never minted', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    h.conn.offerDccChat('bob', { passive: true });
    const minted = Number(h.lastOffer()!.split(' ')[4]);
    const wrong = (minted + 1) % 64;
    // A stray token must not be treated as our reply. With no live session and
    // no listener, the only correct outcome is that nothing was dialled.
    offerFrom(h.conn, 'bob', `CHAT chat 16843009 5000 ${wrong}`);
    expect(h.conn.hasDccChat('bob')).toBe(false);
  });
});

describe('DCC CHAT actions', () => {
  it('sends /me as bare \\x01ACTION\\x01 — the only dialect everyone parses', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    h.conn.dccChatSend('bob', 'waves', { action: true });
    expect(await got).toBe('\u0001ACTION waves\u0001\r\n');
    h.conn.closeDccChat('bob');
  });

  it("parses both action dialects inbound, including irssi's CTCP_MESSAGE prefix", async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    sock.write('\u0001ACTION waves\u0001\r\n');
    sock.write('CTCP_MESSAGE \u0001ACTION nods\u0001\r\n');
    await waitFor(() => h.published.filter((e) => e.type === 'action').length === 2);
    const actions = h.published.filter((e) => e.type === 'action');
    expect(actions.map((e) => e.text)).toEqual(['waves', 'nods']);
    h.conn.closeDccChat('bob');
  });
});

// ⚠⚠ The reason this branch exists. `=bob` is a buffer name, never an IRC
// target, and three separate surfaces can hand one to ircManager: the composer,
// the MCP `send_message` verb (which validates only that the target is
// non-empty) and an attached bouncer client's PRIVMSG. All three converge on
// these four methods, so this is where the guard has to hold.
describe('a = target never reaches the IRC wire', () => {
  it('routes send/action/notice over the DCC socket instead of PRIVMSG', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    const seen: string[] = [];
    sock.on('data', (d) => seen.push(d.toString()));

    expect(ircManager.send(1, 1, '=bob', 'typed in the buffer')).toBe(true);
    expect(ircManager.action(1, 1, '=bob', 'waves')).toBe(true);
    expect(ircManager.notice(1, 1, '=bob', 'a notice')).toBe(true);
    await waitFor(() => seen.join('').split('\r\n').filter(Boolean).length === 3);

    expect(seen.join('')).toBe('typed in the buffer\r\n\u0001ACTION waves\u0001\r\na notice\r\n');
    expect(h.say).not.toHaveBeenCalled();
    expect(h.raw).not.toHaveBeenCalled();
    h.conn.closeDccChat('bob');
  });

  // No valid nick or channel starts with `=`, so a bare `=` is a pseudo-target
  // too — it used to fall through as a DM and go out as `PRIVMSG =`.
  it('refuses a bare = on every send path, silently', () => {
    enableDcc();
    const h = harness();
    inject(h.conn);
    expect(ircManager.send(1, 1, '=', 'hi')).toBe(false);
    expect(ircManager.action(1, 1, '=', 'waves')).toBe(false);
    expect(ircManager.notice(1, 1, '=', 'psst')).toBe(false);
    expect(h.say).not.toHaveBeenCalled();
    expect(h.raw).not.toHaveBeenCalled();
    // A pseudo-target, not a dead chat — no "No live DCC chat with …" line.
    expect(h.notices()).toEqual([]);
  });

  it('refuses a typing notification rather than emitting TAGMSG =bob', () => {
    enableDcc();
    const h = harness();
    inject(h.conn);
    const sendTyping = vi.fn<(target: string, state: string) => void>();
    h.conn.sendTyping = sendTyping;
    expect(ircManager.typing(1, 1, '=bob', 'active')).toBe(false);
    expect(sendTyping).not.toHaveBeenCalled();
  });

  // The guard sits ahead of the writable-connection gate on purpose: a DCC chat
  // is an independent socket and has to keep working while IRC is down.
  //
  // ⚠ This one only proves the WRITABLE gate is bypassed — the connection is
  // still in ircManager's map. The test below covers the case that actually
  // broke in QA, where it isn't.
  it('still delivers while the IRC connection is not writable', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    // The IRC link drops into reconnect backoff mid-chat. writableConnection()
    // now rejects it — the DCC socket must not care.
    h.conn.state = 'reconnecting';
    expect(ircManager.writableConnection(1, 1)).toBeNull();

    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    expect(ircManager.send(1, 1, '=bob', 'still works')).toBe(true);
    expect(await got).toBe('still works\r\n');
    h.conn.closeDccChat('bob');
  });

  it('reports a dead chat rather than swallowing the line', () => {
    enableDcc();
    const h = harness();
    inject(h.conn);
    // No session: the process restarted, but the buffer and its history remain.
    expect(ircManager.send(1, 1, '=bob', 'anyone there?')).toBe(false);
    expect(h.notices().at(-1)).toMatch(/No live DCC chat with bob/);
    // Warned once, not once per keystroke.
    expect(ircManager.send(1, 1, '=bob', 'hello?')).toBe(false);
    expect(h.notices().filter((t) => /No live DCC chat/.test(t))).toHaveLength(1);
    expect(h.say).not.toHaveBeenCalled();
  });
});

// Fixes from the pre-PR review. Each of these is a state-machine edge that only
// shows up when two halves of a handshake race, or when an offer is abandoned.
describe('chat session lifecycle edges', () => {
  // Glare: we accept bob's active offer AND bob answers a listener we opened, so
  // two sockets arrive for one peer. The established session must survive — the
  // old code overwrote the map, orphaning the live socket, and that orphan's
  // eventual onClose then deleted the REPLACEMENT's entry.
  it('keeps the established session when a second socket arrives for the same peer', async () => {
    enableDcc();
    allowLoopback();
    enableListening();
    const h = harness();

    // A listener of ours, opened by accepting bob's passive offer.
    offerAndAccept(h.conn, 'bob', 'CHAT chat 16843009 0 42');
    await waitFor(() => h.lastOffer() !== null);
    const ourPort = Number(h.lastOffer()!.split(' ')[3]);

    // Meanwhile bob's active offer gets accepted too, and that one connects.
    const peer = await startPeer();
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    h.conn.offerDccChat('bob');
    const sockA = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    // Now bob's client also reaches our listener. The newcomer must be dropped.
    const late = net.connect({ host: '127.0.0.1', port: ourPort });
    late.on('error', () => {});
    await waitFor(() => late.destroyed || late.readyState === 'open');

    // Session A is still the live one, and still works.
    const got = new Promise<string>((r) => sockA.once('data', (d) => r(d.toString())));
    expect(h.conn.dccChatSend('bob', 'still session A')).toBe(true);
    expect(await got).toBe('still session A\r\n');

    // And when the dropped socket finally closes, it must not evict session A.
    late.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.conn.hasDccChat('bob')).toBe(true);
    h.conn.closeDccChat('bob');
  });

  // The dial's error handler must not outlive the dial: past connect the socket
  // belongs to DccChat, so a mid-session reset would otherwise print the real
  // error AND a "check your port forwarding" paragraph that is nonsense by then.
  it('reports a mid-session drop once, without the connect-failure advice', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    const before = h.notices().length;
    sock.destroy(new Error('ECONNRESET'));
    await waitFor(() => h.notices().length > before);
    await new Promise((r) => setTimeout(r, 50)); // let any second notice land

    const after = h.notices().slice(before);
    expect(after.filter((t) => /Couldn't connect to/.test(t))).toEqual([]);
    expect(after).toHaveLength(1);
  });

  // The token is 6 bits, so collisions are a 1-in-64 event, not a theoretical
  // one. Reusing a live token would have the displaced offer's timer fire
  // against the new entry and time out the wrong chat.
  it('refuses to mint a passive token that is already in flight', () => {
    enableDcc();
    const h = harness();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // always the same token
    try {
      h.conn.offerDccChat('alice', { passive: true });
      const first = h.lastOffer()!.split(' ')[4];
      h.conn.offerDccChat('bob', { passive: true });
      // No second offer went out, and the user was told why.
      expect(h.lastOffer()!.split(' ')[4]).toBe(first);
      expect(h.notices().at(-1)).toMatch(/Too many passive DCC chat offers/);
    } finally {
      spy.mockRestore();
    }
  });

  // A mistyped `/dcc chat bbo` otherwise pins one of the configured ports for
  // the full 120s timeout — and the range is the documented concurrency cap.
  it('releases the listening port when an unanswered offer is closed', async () => {
    enableDcc();
    enableListening();
    const h = harness();

    h.conn.offerDccChat('bbo');
    await waitFor(() => activeDccListenerCount() === 1);

    expect(h.conn.closeDccChat('bbo')).toBe(true);
    expect(activeDccListenerCount()).toBe(0);
    expect(h.notices().at(-1)).toMatch(/Cancelled the pending DCC chat offer/);
  });

  it('cancels a pending passive offer too', () => {
    enableDcc();
    const h = harness();
    h.conn.offerDccChat('bbo', { passive: true });
    expect(h.conn.closeDccChat('bbo')).toBe(true);
    expect(h.notices().at(-1)).toMatch(/Cancelled the pending DCC chat offer/);
  });
});

// The shared incoming-CTCP limiter allows 3 per minute per peer and then backs
// off for five minutes. It exists to stop us ANSWERING a VERSION/PING storm;
// DCC is never answered, so sharing that budget meant a user's fourth `/dcc
// chat` in a minute vanished with no trace at either end.
describe('a DCC offer does not spend the CTCP reply budget', () => {
  it('still surfaces a fourth offer in a minute', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    // Three unanswerable CTCPs from this peer exhaust the shared bucket.
    for (let i = 0; i < 3; i++) {
      h.conn.client.emit('ctcp request', {
        nick: 'bob',
        ident: 'u',
        hostname: 'host',
        type: 'FROBNICATE',
        message: 'FROBNICATE',
      });
    }
    const before = h.ctcpLines().length;
    h.conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'u',
      hostname: 'host',
      type: 'DCC',
      message: 'DCC CHAT chat 16843009 5000',
    });
    expect(h.ctcpLines().slice(before).join(' ')).toMatch(/wants to start a DCC chat/);
  });

  it('bounds DCC offers on their own key, and says so rather than going quiet', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const offer = () =>
      h.conn.client.emit('ctcp request', {
        nick: 'bob',
        ident: 'u',
        hostname: 'host',
        type: 'DCC',
        message: 'DCC CHAT chat 16843009 5000',
      });
    offer();
    offer();
    offer();
    const before = h.ctcpLines().length;
    offer(); // over the DCC bucket
    const after = h.ctcpLines().slice(before);
    expect(after.join(' ')).toMatch(/Ignoring further DCC requests/);
    // And the warning itself is rate-limited — it must not become the flood.
    const mark = h.ctcpLines().length;
    offer();
    offer();
    expect(h.ctcpLines().slice(mark)).toEqual([]);
  });
});

// ⚠⚠ QA: "I can't send messages via DCC chat when the network is offline."
// ircManager.stopNetwork — the user pressing Disconnect, /disconnect, the REST
// endpoint, the disconnect_network verb — calls conn.disconnect() and then
// DROPS the connection from its map. disconnect() deliberately does no DCC
// teardown, so the socket stayed up while getConnection returned null: the chat
// became unsendable, uncloseable and invisible until the process exited.
//
// irssi is explicit that this is wrong — on "server disconnected" it sets
// `dcc->server = NULL` and leaves the session running (dcc.c:300-312).
describe('a chat survives the network being stopped', () => {
  it('still sends and can still be closed after the connection leaves the map', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    // Exactly what stopNetwork does to the map.
    ircManager.connectionsForUser(1).delete(1);
    expect(ircManager.getConnection(1, 1)).toBeNull();

    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    expect(ircManager.send(1, 1, '=bob', 'network is down, chat is not')).toBe(true);
    expect(await got).toBe('network is down, chat is not\r\n');

    // And it is still closeable — otherwise the socket could never be reclaimed.
    expect(ircManager.dccChatClose(1, 1, 'bob')).toBe(true);
    expect(h.conn.hasDccChat('bob')).toBe(false);
  });

  it('stops holding the connection once its last chat ends', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    ircManager.connectionsForUser(1).delete(1);
    h.conn.closeDccChat('bob');
    // Registry released, so a stale connection isn't kept alive by it.
    expect(ircManager.send(1, 1, '=bob', 'nobody home')).toBe(false);
  });
});

// The offer toast is sticky, so the client needs to be told when the offer is
// no longer live. Otherwise its Accept button outlives the offer and quietly
// stops meaning "accept" — `/dcc chat <nick>` with nothing pending sends the
// peer a NEW offer, which is a different act than the button names.
describe('the inbound offer broadcasts its whole lifecycle', () => {
  it('announces an offer, then its acceptance', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerFrom(h.conn, 'BoB', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    expect(h.offerEvents()).toHaveLength(1);
    expect(h.offerEvents()[0]).toMatchObject({
      type: 'dcc-chat-offer',
      from: 'BoB', // display casing preserved, so the toast reads right
      passive: false,
    });

    h.conn.offerDccChat('BoB');
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('BoB'));
    expect(h.offerEvents().at(-1)).toMatchObject({ type: 'dcc-chat-offer-closed', from: 'BoB' });
    h.conn.closeDccChat('BoB');
  });

  it('announces a decline', () => {
    enableDcc();
    const h = harness();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
    h.conn.closeDccChat('bob');
    expect(h.offerEvents().at(-1)).toMatchObject({ type: 'dcc-chat-offer-closed', from: 'bob' });
  });

  it('announces an expiry', () => {
    vi.useFakeTimers();
    try {
      enableDcc();
      const h = harness();
      offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
      vi.advanceTimersByTime(10 * 60_000 + 1000);
      expect(h.offerEvents().at(-1)).toMatchObject({ type: 'dcc-chat-offer-closed', from: 'bob' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags a passive offer so the toast can say who listens', () => {
    enableDcc();
    enableListening();
    const h = harness();
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 0 42');
    expect(h.offerEvents()[0]).toMatchObject({ type: 'dcc-chat-offer', passive: true });
  });
});

// ⚠⚠ QA: `/dcc chat -passive ami|shellter` produced a toast in Lurker saying
// the user's OWN nick wanted to chat. A network with echo-message sends our
// PRIVMSG back to us, and the passive offer we just sent then looked like an
// unsolicited inbound one — the token-matching branch only covers a non-passive
// REPLY to our offer, not the offer itself coming home.
describe('our own offer echoed back is not an offer', () => {
  it('ignores a passive offer carrying a token we minted', () => {
    enableDcc();
    const h = harness();
    h.conn.offerDccChat('bob', { passive: true });
    const body = h.lastOffer()!; // CHAT chat 16843009 0 <token>
    const token = body.split(' ')[4];
    const before = h.offerEvents().length;

    // ⚠ Deliberately NOT our own nick. The sender check would catch that, and
    // then this test would not be testing the token at all. A server that
    // renamed us — IRCnet truncates long nicks — echoes our line back under a
    // name we don't recognise as ourselves, and the minted token is then the
    // only thing that still identifies the line as ours.
    offerFrom(h.conn, 'someone-we-do-not-know', `CHAT chat 16843009 0 ${token}`);

    expect(h.offerEvents().slice(before)).toEqual([]);
    expect(h.ctcpLines().join(' ')).not.toMatch(/wants to start a DCC chat/);
  });

  // The token is the decisive signal, but an ACTIVE offer carries none of ours,
  // so the sender check still has to hold for that shape.
  it('ignores an active offer that appears to come from ourselves', () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const before = h.offerEvents().length;
    // The harness never registers, so `currentNick` is still the configured
    // nick the constructor seeded it with — which is the name the echo carries
    // in the ordinary case.
    offerFrom(h.conn, 'alice', 'CHAT chat 16843009 5000');
    expect(h.offerEvents().slice(before)).toEqual([]);
  });

  // ⚠⚠ The self check must use currentNick ALONE. Registering under a fallback
  // (the configured nick was taken) leaves the configured nick in someone
  // ELSE'S hands; treating it as us silently dropped their genuine offer as if
  // it were our own echo. A hedge added here back when currentNick could still
  // drift (#972 has since fixed that) did exactly this.
  it('hears an offer from whoever holds our configured nick while we use a fallback', () => {
    enableDcc();
    allowLoopback();
    const h = harness(); // configured as 'alice'
    h.conn.currentNick = 'alice_'; // …but the server registered us as this
    const before = h.offerEvents().length;
    offerFrom(h.conn, 'alice', 'CHAT chat 16843009 5000'); // the real alice
    expect(h.offerEvents().slice(before)).toMatchObject([
      { type: 'dcc-chat-offer', from: 'alice' },
    ]);
  });

  // ...and a real peer answering our passive offer must still get through,
  // which is what stops the guard from swallowing the flow it sits next to.
  it('still accepts a genuine reply to our passive offer', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    h.conn.offerDccChat('bob', { passive: true });
    const token = h.lastOffer()!.split(' ')[4];
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port} ${token}`);
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    expect(h.conn.hasDccChat('bob')).toBe(true);
    // Dialled, not prompted — the reply is the answer to a chat we started.
    expect(h.ctcpLines().join(' ')).not.toMatch(/wants to start a DCC chat/);
    h.conn.closeDccChat('bob');
  });
});

// QA: "put an affordance in the dcc chat buffer, similar to when a user is
// offline, if the session is disconnected". The client can't infer liveness —
// sessions live on the server and survive a page reload — so the server
// reports it: live events for changes, and the list itself in every snapshot.
describe('the client is told whether a chat is live', () => {
  it('announces a session opening and closing', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'BoB', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('BoB'));
    expect(h.stateEvents()).toEqual([{ from: 'BoB', live: true }]);

    h.conn.closeDccChat('BoB');
    expect(h.stateEvents().at(-1)).toEqual({ from: 'BoB', live: false });
  });

  it('announces the peer hanging up', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    sock.end();
    await waitFor(() => h.stateEvents().some((e) => e.live === false));
    expect(h.stateEvents().at(-1)).toEqual({ from: 'bob', live: false });
  });

  // ⚠⚠ The case a naive version gets wrong. A user-initiated disconnect drops
  // the connection from ircManager's map, and that network's snapshot blob is
  // then synthesized from the DB — while the chat socket is still up. Reading
  // the live list off the connection alone would tell a reloaded tab the chat
  // was dead.
  it('reports a live chat in the snapshot even after the network is disconnected', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    ircManager.connectionsForUser(1).delete(1); // what stopNetwork does
    const snap = ircManager.snapshotForUser(1) as Array<{
      networkId: number;
      state: string;
      dccChats: string[];
    }>;
    const net = snap.find((n) => n.networkId === 1)!;
    expect(net.state).toBe('disconnected'); // the synthesized, DB-built blob…
    expect(net.dccChats).toEqual(['bob']); // …still knows the chat is live
    h.conn.closeDccChat('bob');
  });

  it('reports no live chats once they have ended', () => {
    const snap = ircManager.snapshotForUser(1) as Array<{ networkId: number; dccChats: string[] }>;
    expect(snap.find((n) => n.networkId === 1)!.dccChats).toEqual([]);
  });
});

// Findings from the pre-PR review of the whole branch.
describe('review: chats that outlive their connection', () => {
  // A second connection object for the same network, as startNetwork builds on
  // reconnect when a Disconnect has already dropped the first from the map.
  function reconnectedConn() {
    const conn = makeConn();
    conn.state = 'connected';
    const published: Array<Record<string, unknown>> = [];
    conn.publish = (e: Record<string, unknown>) => {
      published.push(e);
      return undefined;
    };
    conn.publishEphemeral = () => {};
    conn.client.ctcpRequest = vi.fn<(t: string, type: string, ...p: string[]) => void>();
    conn.client.say = vi.fn<(t: string, text: string) => void>();
    const notices = () =>
      published.filter((e) => e.type === 'notice').map((e) => String(e.text ?? ''));
    return { conn, notices };
  }

  async function liveChatThenDisconnect(h: ReturnType<typeof harness>) {
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    ircManager.connectionsForUser(1).delete(1); // what stopNetwork does
    return sock;
  }

  // ⚠⚠ #1. After Disconnect + reconnect the chat's owner and the mapped
  // connection are different objects. Asking the mapped one first sent every
  // line to the new connection, which has no session ("No live DCC chat").
  it('routes a send to the session owner, not the reconnected connection', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const sock = await liveChatThenDisconnect(h);
    const fresh = reconnectedConn();
    inject(fresh.conn); // the reconnect

    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    expect(ircManager.send(1, 1, '=bob', 'still reachable')).toBe(true);
    expect(await got).toBe('still reachable\r\n');
    expect(fresh.notices().join(' ')).not.toMatch(/No live DCC chat/);
    ircManager.dccChatClose(1, 1, 'bob');
  });

  it('refuses a second chat with the same peer from the reconnected connection', async () => {
    enableDcc();
    allowLoopback();
    enableListening();
    const h = harness();
    inject(h.conn);
    await liveChatThenDisconnect(h);
    const fresh = reconnectedConn();
    inject(fresh.conn);

    fresh.conn.offerDccChat('bob');
    expect(fresh.notices().at(-1)).toMatch(/Already in a DCC chat with bob/);
    expect(fresh.conn.client.ctcpRequest).not.toHaveBeenCalled();
    ircManager.dccChatClose(1, 1, 'bob');
  });

  it('closes a chat whose owner the map no longer holds', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    await liveChatThenDisconnect(h);
    inject(reconnectedConn().conn);
    expect(ircManager.dccChatClose(1, 1, 'bob')).toBe(true);
    expect(h.conn.hasDccChat('bob')).toBe(false);
  });

  // ⚠⚠ #2. disposeNetwork only reaches the mapped connection, so a network
  // deleted after a Disconnect left the owner's socket publishing into a
  // network that no longer existed.
  it('ends a chat on network delete even when its owner is out of the map', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    await liveChatThenDisconnect(h);
    ircManager.endDccChats(1, 1, 'network removed');
    expect(h.conn.hasDccChat('bob')).toBe(false);
  });

  it('ends a chat on user delete even when its owner is out of the map', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    await liveChatThenDisconnect(h);
    ircManager.disposeUser(1, 'user deleted');
    expect(h.conn.hasDccChat('bob')).toBe(false);
  });

  // …while Reconnect, which runs through disposeNetwork, must NOT end it: the
  // whole point of surviving a Disconnect is surviving the reconnect after.
  it('keeps the chat across a Reconnect after a Disconnect', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    await liveChatThenDisconnect(h);
    ircManager.disposeNetwork(1, 1, 'reconnecting'); // what restartNetwork does first
    expect(h.conn.hasDccChat('bob')).toBe(true);
    ircManager.dccChatClose(1, 1, 'bob');
  });
});

describe('review: offers on a link that is down', () => {
  // #3. irc-framework drops a write during reconnect backoff, so an offer
  // there was announced as sent, held a port for 120s, then blamed the peer.
  it('refuses to send an offer, and holds no port, while the link is down', () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.state = 'reconnecting';
    h.conn.offerDccChat('bob');
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(h.notices().at(-1)).toMatch(/not connected/);
    expect(activeDccListenerCount()).toBe(0);
  });

  it('refuses a passive offer too', () => {
    enableDcc();
    const h = harness();
    h.conn.state = 'reconnecting';
    h.conn.offerDccChat('bob', { passive: true });
    expect(h.ctcpRequest).not.toHaveBeenCalled();
  });

  // Accepting an ACTIVE offer only dials — no CTCP rides the link — so it has
  // to keep working while IRC is down.
  it('still accepts an active offer while the link is down', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    const peer = await startPeer();
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    h.conn.state = 'reconnecting';
    h.conn.offerDccChat('bob');
    await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    expect(h.conn.hasDccChat('bob')).toBe(true);
    expect(h.notices().join(' ')).not.toMatch(/not connected/);
    h.conn.closeDccChat('bob');
  });
});

describe('review: small ones', () => {
  // #4. A deliberate cancel rejects the listener's accepted promise, and its
  // catch used to report "failed: DCC listener closed" on top of "Cancelled".
  it('cancelling an offer does not also report it as failed', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.offerDccChat('bbo');
    await waitFor(() => activeDccListenerCount() === 1);
    h.conn.closeDccChat('bbo');
    await new Promise((r) => setTimeout(r, 20)); // let the rejection settle
    expect(h.notices().at(-1)).toMatch(/Cancelled the pending DCC chat offer/);
    expect(h.notices().join(' ')).not.toMatch(/failed/);
  });

  // #5. A passive offer's address is a placeholder the peer ignores, so a
  // hostname in LURKER_DCC_EXTERNAL_HOST — which can't be encoded — must not
  // stop the mode meant for servers without a usable external address.
  it('sends a passive offer even when the external host is a hostname', () => {
    enableDcc();
    process.env.LURKER_DCC_EXTERNAL_HOST = 'dcc.example.com';
    const h = harness();
    h.conn.offerDccChat('bob', { passive: true });
    expect(h.lastOffer()).toMatch(/^CHAT chat 16843009 0 \d+$/);
    expect(h.notices().join(' ')).not.toMatch(/misconfigured/);
  });
});

// Copilot review on #973.
describe('review #973: a chat is with a person, never a channel', () => {
  // The offer is a CTCP to `nick`, so a channel name broadcasts it to everyone
  // there — and an active offer opens a port any of them can race for. All
  // four sigils: a `#`-only test is this codebase's most repeated bug.
  it.each(['#room', '&local', '+nomodes', '!safe'])('refuses to offer to %s', (target) => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.offerDccChat(target);
    h.conn.offerDccChat(target, { passive: true });
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(activeDccListenerCount()).toBe(0);
  });
});

describe('review #973: a deliberate disconnect ends in-flight handshakes', () => {
  function stubQuit(h: ReturnType<typeof harness>) {
    h.conn.client.quit = vi.fn<(msg?: string) => void>();
  }

  // After stopNetwork unmaps this connection, a reconnect builds a new one that
  // knows nothing of the offer — so its Accept would send the peer a FRESH
  // offer. Ending it here retires the toast now, and says why.
  it('drops a pending inbound offer and tells the client it is closed', () => {
    enableDcc();
    const h = harness();
    stubQuit(h);
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 5000');
    expect(h.conn.pendingDccChatOffers()).toEqual(['bob']);

    h.conn.disconnect('user disconnected');
    expect(h.conn.pendingDccChatOffers()).toEqual([]);
    expect(h.offerEvents().at(-1)).toMatchObject({ type: 'dcc-chat-offer-closed', from: 'bob' });
    expect(h.ctcpLines().join(' ')).toMatch(/Dropped the DCC chat offer from bob/);
  });

  // Our own passive offer's reply can only arrive over IRC, and it would land
  // on the new connection, which never minted the token.
  it('forgets our own pending passive offer', () => {
    enableDcc();
    const h = harness();
    stubQuit(h);
    h.conn.offerDccChat('bob', { passive: true });
    const token = h.lastOffer()!.split(' ')[4];
    h.conn.disconnect('user disconnected');
    // A late "reply" with our old token is no longer treated as one: it's an
    // unsolicited offer now, and asks rather than dials.
    h.conn.state = 'connected';
    offerFrom(h.conn, 'bob', `CHAT chat 16843009 5000 ${token}`);
    expect(h.notices().join(' ')).not.toMatch(/Connecting to bob/);
  });

  // …but an ESTABLISHED chat is a socket that needs no IRC, and survives.
  it('leaves an established chat running', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    stubQuit(h);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    h.conn.disconnect('user disconnected');
    expect(h.conn.hasDccChat('bob')).toBe(true);
    const got = new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
    h.conn.dccChatSend('bob', 'still here');
    expect(await got).toBe('still here\r\n');
    h.conn.closeDccChat('bob');
  });
});

// Copilot's second pass on #973 named "listener teardown races". The gap is
// between deciding we may offer and the port actually being bound: the
// listener only joined dccChatListeners once bound, so anything ending the
// offer inside that gap found nothing to end.
describe('review #973: ending an offer while its port is still binding', () => {
  // `offerDccChat` returns before the bind resolves; these act in that gap.
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('a cancel in the gap stops the offer, frees the port, and says so', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.offerDccChat('bob');
    expect(h.conn.closeDccChat('bob')).toBe(true); // was false: "no live DCC chat"
    await settle();
    expect(h.ctcpRequest).not.toHaveBeenCalled(); // was: the offer went out anyway
    expect(activeDccListenerCount()).toBe(0); // was: held until its timeout
    expect(h.notices().join(' ')).toMatch(/Cancelled the pending DCC chat offer/);
  });

  it('a teardown in the gap sends nothing and leaks no port', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.client.quit = vi.fn<(m?: string) => void>();
    h.conn.offerDccChat('bob');
    h.conn.dispose('network removed');
    await settle();
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(activeDccListenerCount()).toBe(0);
  });

  // Not a disconnect() — the link dropping on its own, so nothing cancelled the
  // request. The offer can't go out, and the user shouldn't be left waiting.
  it('a link that drops in the gap sends nothing, frees the port, and explains', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.offerDccChat('bob');
    h.conn.state = 'reconnecting';
    await settle();
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(activeDccListenerCount()).toBe(0);
    expect(h.notices().at(-1)).toMatch(/Couldn't send the DCC chat offer/);
  });

  // The per-request token: a cancel then an immediate re-offer must leave the
  // SECOND one live — a plain per-nick flag would let the first bind, resolving
  // late, be mistaken for it.
  it('a cancel then an immediate re-offer sends exactly the second', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    h.conn.offerDccChat('bob');
    h.conn.closeDccChat('bob');
    h.conn.offerDccChat('bob');
    await settle();
    expect(h.ctcpRequest).toHaveBeenCalledTimes(1);
    expect(activeDccListenerCount()).toBe(1);
    h.conn.closeDccChat('bob');
  });

  it('the reverse reply to a passive offer honours a cancel in the gap too', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    offerAndAccept(h.conn, 'bob', 'CHAT chat 16843009 0 42'); // accept → binds for the reply
    h.conn.closeDccChat('bob');
    await settle();
    expect(h.ctcpRequest).not.toHaveBeenCalled();
    expect(activeDccListenerCount()).toBe(0);
  });
});

// irssi ends a DCC chat when its `=nick` window closes (fe-dcc-chat.c:198-210),
// and so does WeeChat (xfer_chat_buffer_close_cb). Closing the buffer used to
// only hide it: the chat ran on out of sight and came back when the peer spoke.
describe('closing a =nick buffer ends the chat', () => {
  it('ends a live session — after the row closes, so its notice reaches no client', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerAndAccept(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));
    ensureOpen(1, 1, '=bob', { kind: 'dcc' });

    // Whether the row was already closed when the chat's closing notice went
    // out. It must be: the live filter then drops the line, where an open row
    // let it reach a client that had removed the row on Close, which minted it
    // again from the line until buffer-closed arrived.
    let closedAtNotice: boolean | null = null;
    // Called with the connection as `this`, so the wrapper stays a faithful
    // stand-in whatever `publish` is underneath — the harness's arrow function
    // today, the real method (which reads instance state) if that ever changes.
    const publish = h.conn.publish;
    h.conn.publish = (event: Parameters<typeof publish>[0]) => {
      if (event.type === 'notice' && /closed/.test(String(event.text))) {
        closedAtNotice = isClosed(1, 1, '=bob');
      }
      return publish.call(h.conn, event);
    };

    const hungUp = new Promise<void>((r) => sock.once('close', () => r()));
    closeBuffer(1, 1, '=bob');
    await hungUp;
    expect(h.conn.hasDccChat('bob')).toBe(false);
    expect(closedAtNotice).toBe(true);
  });

  it('cancels our pending offer, releasing its port', async () => {
    enableDcc();
    enableListening();
    const h = harness();
    inject(h.conn);
    h.conn.offerDccChat('bob');
    await waitFor(() => h.lastOffer() !== null);
    expect(activeDccListenerCount()).toBe(1);
    ensureOpen(1, 1, '=bob', { kind: 'dcc' });
    closeBuffer(1, 1, '=bob');
    expect(activeDccListenerCount()).toBe(0);
    expect(h.notices()).toContain('Cancelled the pending DCC chat offer to bob.');
  });

  it('declines their offer', () => {
    enableDcc();
    const h = harness();
    inject(h.conn);
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} 4000`);
    expect(h.conn.pendingDccChatOffers()).toEqual(['bob']);
    closeBuffer(1, 1, '=bob');
    expect(h.conn.pendingDccChatOffers()).toEqual([]);
    expect(h.ctcpLines()).toContain('Declined the DCC chat offer from bob.');
  });
});
