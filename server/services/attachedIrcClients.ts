// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// How many IRC clients attached through the bouncer count as the user on one
// network: bound to it, and not marked `AWAY *` (bouncer.ts countsAsPresent).
// IrcConnection asks before leaving a CTCP request to them (#932). The bouncer
// sets the count: IrcConnection can't import the bouncer, which imports
// ircManager, which imports IrcConnection.

type Counter = (userId: number, networkId: number) => number;

let counter: Counter | null = null;

/** How to count, or null when no bouncer runs: every network then has none. */
export function setAttachedIrcClientCounter(count: Counter | null): void {
  counter = count;
}

/** The IRC clients on a network that count as the user. */
export function attachedIrcClients(userId: number, networkId: number): number {
  return counter ? counter(userId, networkId) : 0;
}
