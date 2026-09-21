// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Where live DCC chats can be reached from, independently of the IrcConnection
// that set them up (#270).
//
// ⚠⚠ A DCC chat is a peer-to-peer socket. After the CTCP handshake it has
// nothing to do with the IRC connection, and it must outlive one: irssi models
// this explicitly — on "server disconnected" it sets `dcc->server = NULL` and
// leaves the session running (dcc.c:300-312).
//
// Hanging the sessions off IrcConnection alone did not survive that, because
// ircManager.stopNetwork (the user pressing Disconnect, /disconnect, the REST
// endpoint, the disconnect_network verb) drops the connection out of its map
// while `disconnect()` deliberately does NO DCC teardown. The socket stayed
// open and became unreachable: not sendable, not closeable, invisible until the
// process exited. This registry is the seam that keeps it addressable.
//
// The registry holds a connection only while it actually has a live chat, so a
// disconnected connection is not kept alive past its last session.

/** What ircManager needs of a live chat's owner. Deliberately narrow — a full
 *  IrcConnection import here would close an ircManager ↔ ircConnection cycle. */
export interface DccChatHost {
  hasDccChat(nick: string): boolean;
  dccChatSend(nick: string, text: string, opts?: { action?: boolean }): boolean;
  closeDccChat(nick: string): boolean;
}

const hosts = new Map<string, DccChatHost>();

export function dccChatKey(userId: number, networkId: number): string {
  return `${userId}:${networkId}`;
}

/** Called when a session opens. Idempotent. */
export function registerDccChatHost(key: string, host: DccChatHost): void {
  hosts.set(key, host);
}

/** Called when a connection's last session ends, or it is disposed. Identity
 *  checked, so a superseded connection can't evict its replacement's entry. */
export function unregisterDccChatHost(key: string, host: DccChatHost): void {
  if (hosts.get(key) === host) hosts.delete(key);
}

/** The owner of any live chat on this network, or null. */
export function dccChatHost(key: string): DccChatHost | null {
  return hosts.get(key) ?? null;
}

/** Tests only — production never calls this. */
export function resetDccChatHosts(): void {
  hosts.clear();
}
