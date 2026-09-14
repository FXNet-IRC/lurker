// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A network connection's MONITOR list. The network gives each connection one
// list, and two kinds of user share it: Lurker itself (DM presence and
// nick-regain) and every IRC client attached through the bouncer. Each client
// keeps its own list; this merges them with Lurker's nicks and sends the
// network only the difference, as soju's updateMonitor does (upstream.go).
//
// It also keeps the network's last answer for each nick. A client that adds a
// nick already on the list is answered from that, because the network won't
// add the nick twice and needn't answer for it again.

export interface MonitorHolder {
  /** The nicks this holder watches, oldest first. */
  monitorTargets(): Iterable<string>;
  /** Nicks that didn't fit under the network's limit, so aren't watched. */
  onMonitorDropped(nicks: string[], limit: number): void;
}

export interface MonitorSync {
  /** Nicks this sync sent with `MONITOR +`. */
  added: string[];
  /** Lurker's own nicks that didn't fit under the limit. */
  skipped: string[];
  /** The limit this sync kept to: the network's, or lower once it refused a nick. */
  limit: number;
}

// Bytes of targets on one line: room for the command, CRLF and one more long
// nick under the 512-byte line limit.
const MAX_TARGET_BYTES = 400;

/** Pack nicks into comma lists of at most `maxBytes` each. */
export function packTargets(nicks: string[], maxBytes = MAX_TARGET_BYTES): string[] {
  const lists: string[] = [];
  let current = '';
  for (const nick of nicks) {
    const next = current ? `${current},${nick}` : nick;
    if (current && Buffer.byteLength(next) > maxBytes) {
      lists.push(current);
      current = nick;
    } else {
      current = next;
    }
  }
  if (current) lists.push(current);
  return lists;
}

export class MonitorList {
  // Folded nick → the nick as sent, the network's last answer for it (null
  // until it gives one), and its slot: how many nicks were listed when it was
  // added, which is how many of ours the network held when it took the add.
  private readonly listed = new Map<
    string,
    { nick: string; online: boolean | null; slot: number }
  >();
  private readonly holders = new Set<MonitorHolder>();
  // How many nicks the network really takes. Its ISUPPORT limit can overstate
  // that: nicks Lurker didn't add share the list (a connect command's
  // MONITOR +), and a server can cap a list it advertises as unlimited.
  private cap = Infinity;
  // A MONITOR S is queued for the end of this turn (requestStatus).
  private statusQueued = false;
  private readonly send: (line: string) => void;

  constructor(send: (line: string) => void) {
    this.send = send;
  }

  addHolder(holder: MonitorHolder): void {
    this.holders.add(holder);
  }

  /** False if `holder` wasn't one. */
  removeHolder(holder: MonitorHolder): boolean {
    return this.holders.delete(holder);
  }

  /**
   * The network's last answer for `nick`: true for online, false for offline,
   * null if it's listed but unanswered, undefined if it isn't listed.
   */
  status(nick: string): boolean | null | undefined {
    return this.listed.get(fold(nick))?.online;
  }

  /** Record a 730 (online) or 731 (offline). Unlisted nicks are ignored. */
  noteStatus(nicks: string[], online: boolean): void {
    for (const nick of nicks) {
      const entry = this.listed.get(fold(nick));
      if (entry) entry.online = online;
    }
  }

  /**
   * Forget nicks the network refused with a 734. Its list was full at the
   * refused nick's slot, so nothing more is added past that until a nick comes
   * off; otherwise every sync would send the refused nicks again and draw
   * another 734. The slot, not this list's size by the time the 734 arrives: a
   * nick removed in the meantime would leave the cap too low.
   */
  noteRefused(nicks: string[]): void {
    let slot = Infinity;
    for (const nick of nicks) {
      const entry = this.listed.get(fold(nick));
      if (!entry) continue;
      slot = Math.min(slot, entry.slot);
      this.listed.delete(fold(nick));
    }
    if (slot !== Infinity) this.cap = slot;
  }

  /**
   * Ask the network for the state of every listed nick: one MONITOR S at the
   * end of this turn, however many callers ask in it. A client may send a
   * MONITOR + per nick.
   */
  requestStatus(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      if (this.listed.size > 0) this.send('MONITOR S');
    });
  }

  /** The socket closed, and the network's list went with it. */
  reset(): void {
    this.listed.clear();
    this.cap = Infinity;
  }

  /**
   * Bring the network's list in line with Lurker's nicks (`own`) and every
   * holder's. Nicks nobody wants are removed first, to make room. Listed nicks
   * stay listed, and new ones are added in order, Lurker's first, while there's
   * room under `limit`, or under the lower cap a 734 showed.
   */
  sync(own: Iterable<string>, limit: number): MonitorSync {
    const wanted = new Map<string, string>();
    const ownKeys = new Set<string>();
    for (const nick of own) {
      if (!nick) continue;
      const key = fold(nick);
      if (!wanted.has(key)) wanted.set(key, nick);
      ownKeys.add(key);
    }
    // Who asked for each nick, and how they spelled it, to tell them if it
    // doesn't fit.
    const wantedBy = new Map<string, Array<[MonitorHolder, string]>>();
    for (const holder of this.holders) {
      for (const nick of holder.monitorTargets()) {
        if (!nick) continue;
        const key = fold(nick);
        if (!wanted.has(key)) wanted.set(key, nick);
        const askers = wantedBy.get(key);
        if (askers) askers.push([holder, nick]);
        else wantedBy.set(key, [[holder, nick]]);
      }
    }

    const removed: string[] = [];
    for (const [key, entry] of this.listed) {
      if (wanted.has(key)) continue;
      this.listed.delete(key);
      removed.push(entry.nick);
    }

    const room = Math.min(limit, this.cap);
    const added: string[] = [];
    const skipped: string[] = [];
    const dropped = new Map<MonitorHolder, string[]>();
    for (const [key, nick] of wanted) {
      if (this.listed.has(key)) continue;
      if (this.listed.size >= room) {
        if (ownKeys.has(key)) skipped.push(nick);
        for (const [holder, asSent] of wantedBy.get(key) ?? []) {
          const nicks = dropped.get(holder);
          if (nicks) nicks.push(asSent);
          else dropped.set(holder, [asSent]);
        }
        continue;
      }
      this.listed.set(key, { nick, online: null, slot: this.listed.size });
      added.push(nick);
    }

    for (const targets of packTargets(removed)) this.send(`MONITOR - ${targets}`);
    for (const targets of packTargets(added)) this.send(`MONITOR + ${targets}`);
    // A network is only advised to answer an add with the nick's state, so ask
    // (#302), whoever the added nicks belong to.
    if (added.length > 0) this.requestStatus();
    for (const [holder, nicks] of dropped) holder.onMonitorDropped(nicks, room);
    return { added, skipped, limit: room };
  }
}

// Lurker folds nicks with toLowerCase everywhere else, trackedPeers included.
function fold(nick: string): string {
  return nick.toLowerCase();
}
