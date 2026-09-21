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
// while `disconnect()` deliberately does NO DCC teardown. This registry is the
// seam that keeps those sessions addressable.
//
// ⚠⚠ Several hosts per network, not one. A reconnect after a user Disconnect
// builds a NEW IrcConnection (startNetwork finds nothing in the map), while the
// OLD one still owns the chat socket. So there can be two live owners for one
// network at once, and every lookup has to find the one that owns a given peer:
// routing by network alone sent sends to the new connection ("no live chat")
// and let a fresh chat overwrite the old owner's entry, orphaning its socket.
// And teardown has to reach ALL of them — ircManager's dispose paths only see
// the mapped connection, so a network deleted after a Disconnect left the old
// socket publishing into a network that no longer existed.
//
// A connection is held only while it owns a live chat, so a disconnected one
// is not kept alive past its last session.

/** What ircManager needs of a live chat's owner. Deliberately narrow — a full
 *  IrcConnection import here would close an ircManager ↔ ircConnection cycle. */
export interface DccChatHost {
  hasDccChat(nick: string): boolean;
  /** Display nicks of every peer with a live session right now. */
  liveDccChatPeers(): string[];
  dccChatSend(nick: string, text: string, opts?: { action?: boolean }): boolean;
  closeDccChat(nick: string): boolean;
  /** End every session this host owns — for network/user teardown. */
  closeAllDccChats(reason: string): void;
}

const hosts = new Map<string, Set<DccChatHost>>();

export function dccChatKey(userId: number, networkId: number): string {
  return `${userId}:${networkId}`;
}

/** Called when a session opens. Idempotent. */
export function registerDccChatHost(key: string, host: DccChatHost): void {
  let set = hosts.get(key);
  if (!set) hosts.set(key, (set = new Set()));
  set.add(host);
}

/** Called when a host's last session ends, or it is disposed. */
export function unregisterDccChatHost(key: string, host: DccChatHost): void {
  const set = hosts.get(key);
  if (!set) return;
  set.delete(host);
  if (set.size === 0) hosts.delete(key);
}

/** The host that owns a live session with `peer` on this network, or null. */
export function dccChatHostFor(key: string, peer: string): DccChatHost | null {
  for (const host of hosts.get(key) ?? []) if (host.hasDccChat(peer)) return host;
  return null;
}

/** Every host holding a live session on this network. */
export function dccChatHostsFor(key: string): DccChatHost[] {
  return [...(hosts.get(key) ?? [])];
}

/** Every host holding a live session for this user, across all networks. */
export function dccChatHostsForUser(userId: number): DccChatHost[] {
  const prefix = `${userId}:`;
  const out: DccChatHost[] = [];
  for (const [key, set] of hosts) if (key.startsWith(prefix)) out.push(...set);
  return out;
}

/** Tests only — production never calls this. */
export function resetDccChatHosts(): void {
  hosts.clear();
}
