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
import { resetDccListeners } from './dccListener.js';

beforeAll(() => {
  createUser('dcc-chat-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

// A high, uncommon range so a listening test can't collide with anything real.
const LISTEN_MIN = 45840;
const LISTEN_MAX = 45849;

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
  const ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const say = vi.fn<(target: string, text: string) => void>();
  const raw = vi.fn<(line: string) => void>();
  const published: Array<Record<string, unknown>> = [];
  conn.client.ctcpRequest = ctcpRequest;
  conn.client.say = say;
  conn.raw = raw;
  conn.publish = (event: Record<string, unknown>) => {
    published.push(event);
    return undefined;
  };
  // The body of the last outgoing CTCP DCC request: ctcpRequest(target,'DCC',body).
  const lastOffer = (): string | null => {
    const call = ctcpRequest.mock.calls.at(-1);
    return call ? call.slice(2).join(' ') : null;
  };
  const notices = () =>
    published.filter((e) => e.type === 'notice').map((e) => String(e.text ?? ''));
  const chatLines = () =>
    published.filter((e) => e.type === 'message' && e.kind === 'dcc-chat') as Array<{
      text: string;
      self?: boolean;
      target: string;
    }>;
  return { conn, ctcpRequest, say, raw, published, lastOffer, notices, chatLines };
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

    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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

    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 0 42');
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
    offerFrom(h.conn, 'bob', 'CHAT chat 16843009 0 42');
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
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
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
  it('still delivers while the IRC connection is not writable', async () => {
    enableDcc();
    allowLoopback();
    const h = harness();
    inject(h.conn);
    const peer = await startPeer();
    offerFrom(h.conn, 'bob', `CHAT chat ${encodeDccAddress('127.0.0.1')} ${peer.port}`);
    const sock = await peer.socket;
    await waitFor(() => h.conn.hasDccChat('bob'));

    // writableConnection() would reject this connection — it never registered.
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
