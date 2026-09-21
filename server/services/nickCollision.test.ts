// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Keeping track of who we are across a netsplit nick collision.
//
// When a split heals and two clients hold the same nick, the server resolves it
// by SAVEing one of them to its unique ID — Libera says so in as many words:
// "042AAEL37 Nick collision, forcing nick change to your unique ID".
//
// ⚠⚠ irc-framework refuses to store a nick that begins with a digit
// (client.js:266, "reserved for uuids ... they cannot be used"), so its
// `user.nick` keeps the PRE-collision nick indefinitely. The change that takes
// you back to a real nick then has an old nick matching neither what the
// framework thinks nor, if we key off the framework, what we think. Identity is
// lost for the rest of the session, and it surfaces far from here: own-nick
// stops updating, the auto-highlight rule keeps the old name, and self-echo
// filtering starts treating our own lines as a stranger's — which is how this
// was found, as a DCC chat offer apparently sent by the user to themselves.
//
// ⚠ These drive Lurker's handler by emitting on the client directly, which is
// how the rest of ircConnection.test.ts works. irc-framework's own nick
// listener lives on command_handler and does NOT run here, so nothing below
// asserts anything about the framework's behaviour — only about ours.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll } from 'vitest';

import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';

beforeAll(() => {
  createUser('collide');
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'amiantos|sh' });
});

function makeConn() {
  const conn = new IrcConnection({
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
      nick: 'amiantos|sh',
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
    } as never,
    onEvent: () => {},
  });
  const published: Array<Record<string, unknown>> = [];
  conn.publish = (e: Record<string, unknown>) => {
    published.push(e);
    return undefined;
  };
  conn.client.user.nick = 'amiantos|sh';
  return { conn, published };
}

const ownNicks = (published: Array<Record<string, unknown>>) =>
  published.filter((e) => e.type === 'own-nick').map((e) => e.nick);

describe('a nick collision forced to a UID', () => {
  it('follows us to the UID and back to a real nick', () => {
    const { conn, published } = makeConn();
    expect(conn.currentNick).toBe('amiantos|sh');

    conn.client.emit('nick', { nick: 'amiantos|sh', new_nick: '042AAEL37' });
    expect(conn.currentNick).toBe('042AAEL37');

    // The one that used to be lost: the framework's user.nick is stale here, so
    // this event's old nick matches only OUR record of it.
    conn.client.emit('nick', { nick: '042AAEL37', new_nick: 'amiantos|sh1' });
    expect(conn.currentNick).toBe('amiantos|sh1');
    expect(ownNicks(published)).toEqual(['042AAEL37', 'amiantos|sh1']);
  });

  // ircManager attributes a self-message with `client.user.nick`, so a stale one
  // puts the wrong name on the user's own lines.
  it('repairs the framework copy once we hold a usable nick again', () => {
    const { conn } = makeConn();
    conn.client.emit('nick', { nick: 'amiantos|sh', new_nick: '042AAEL37' });
    // ⚠ This asserts OUR repair declines to write a UID there — not the
    // framework's own rule, which these tests never reach: emitting on the
    // client skips command_handler, where its listener lives. Ours mirrors it
    // deliberately, because other parts of the framework treat user.nick as
    // something you could send as.
    expect(conn.client.user.nick).toBe('amiantos|sh');

    conn.client.emit('nick', { nick: '042AAEL37', new_nick: 'amiantos|sh1' });
    expect(conn.client.user.nick).toBe('amiantos|sh1');
  });

  it('survives being saved twice without getting stuck', () => {
    const { conn } = makeConn();
    conn.client.emit('nick', { nick: 'amiantos|sh', new_nick: '042AAEL37' });
    conn.client.emit('nick', { nick: '042AAEL37', new_nick: '042BBEM48' });
    conn.client.emit('nick', { nick: '042BBEM48', new_nick: 'amiantos|sh' });
    expect(conn.currentNick).toBe('amiantos|sh');
  });

  // The widened test must not start claiming other people's nick changes.
  it('still does not treat a stranger as us', () => {
    const { conn, published } = makeConn();
    conn.client.emit('nick', { nick: 'someoneelse', new_nick: 'someoneelse2' });
    expect(conn.currentNick).toBe('amiantos|sh');
    expect(ownNicks(published)).toEqual([]);
  });

  // ⚠⚠ The reason our own record is the authority rather than the framework's.
  // While we sit on a UID, its user.nick still names our old nick — which is
  // now FREE. If a stranger takes it and renames, keying off the stale copy
  // would have us follow them and adopt their new nick as our own.
  it('does not follow a stranger who took our old nick while we were saved', () => {
    const { conn, published } = makeConn();
    conn.client.emit('nick', { nick: 'amiantos|sh', new_nick: '042AAEL37' });
    expect(conn.client.user.nick).toBe('amiantos|sh'); // stale, and now unowned

    conn.client.emit('nick', { nick: 'amiantos|sh', new_nick: 'mallory' });
    expect(conn.currentNick).toBe('042AAEL37');
    expect(ownNicks(published)).toEqual(['042AAEL37']);
  });
});
