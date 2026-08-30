// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import ircManager from '../ircManager.js';
import type { IrcConnection } from '../ircConnection.js';

// Resolve the connection a verb may actually WRITE to.
//
// `getConnection() !== null` is not the same question. Since the auto-reconnect
// overhaul a dropped network keeps its IrcConnection in the manager's map for
// the whole outage while the retry controller backs off, so the object outlives
// the socket. irc-framework's Connection.write() then returns false and DROPS
// the line (connection.js), which is invisible from here — the verb would
// answer { ok: true } for a command that never left the process, and an agent
// would sit polling recent_messages for a reply that can never arrive.
//
// Every one of these verbs documents "not-connected when the network is
// offline", and this is what makes that true rather than aspirational. Reads of
// already-materialised state (get_topic, list_members) deliberately do NOT go
// through here: they return last-known membership, which is stale but not a
// lie, and refusing them mid-reconnect would be strictly less useful.
//
// The test itself lives on ircManager (the send path needs the same gate and
// can't import this module without a cycle); this stays the verbs' name for it.
export function writableConnection(userId: number, networkId: number): IrcConnection | null {
  return ircManager.writableConnection(userId, networkId);
}
