// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { MonitorList, packTargets } from './monitorList.js';
import type { MonitorHolder } from './monitorList.js';

function makeList(): { list: MonitorList; sent: string[] } {
  const sent: string[] = [];
  return { list: new MonitorList((line) => sent.push(line)), sent };
}

// A bouncer client's list, as far as MonitorList sees one.
class Holder implements MonitorHolder {
  nicks: string[];
  dropped: Array<{ nicks: string[]; limit: number }> = [];

  constructor(...nicks: string[]) {
    this.nicks = nicks;
  }

  monitorTargets(): Iterable<string> {
    return this.nicks;
  }

  onMonitorDropped(nicks: string[], limit: number): void {
    this.dropped.push({ nicks, limit });
    this.nicks = this.nicks.filter((n) => !nicks.includes(n));
  }
}

describe('MonitorList.sync', () => {
  it('sends only the nicks that are not listed yet', () => {
    const { list, sent } = makeList();
    list.sync(['alice'], Infinity);
    list.addHolder(new Holder('Alice', 'bob'));
    list.sync(['alice'], Infinity);
    expect(sent).toEqual(['MONITOR + alice', 'MONITOR + bob']);
  });

  it('keeps a nick listed until the last holder lets go', () => {
    const { list, sent } = makeList();
    const a = new Holder('carol');
    const b = new Holder('carol');
    list.addHolder(a);
    list.addHolder(b);
    list.sync([], Infinity);
    list.removeHolder(a);
    list.sync([], Infinity);
    expect(sent).toEqual(['MONITOR + carol']);
    list.removeHolder(b);
    list.sync([], Infinity);
    expect(sent).toEqual(['MONITOR + carol', 'MONITOR - carol']);
  });

  it("never removes one of Lurker's own nicks when a holder lets go", () => {
    const { list, sent } = makeList();
    const h = new Holder('dave');
    list.addHolder(h);
    list.sync(['dave'], Infinity);
    list.removeHolder(h);
    list.sync(['dave'], Infinity);
    expect(sent).toEqual(['MONITOR + dave']);
  });

  it('removes before it adds, so a freed slot is reused under the limit', () => {
    const { list, sent } = makeList();
    list.sync(['a', 'b'], 2);
    const result = list.sync(['a', 'c'], 2);
    expect(sent).toEqual(['MONITOR + a,b', 'MONITOR - b', 'MONITOR + c']);
    expect(result).toEqual({ added: ['c'], skipped: [], limit: 2 });
  });

  it("adds Lurker's nicks first and tells a holder which of its nicks didn't fit", () => {
    const { list, sent } = makeList();
    const h = new Holder('x', 'y');
    list.addHolder(h);
    const result = list.sync(['own'], 2);
    expect(sent).toEqual(['MONITOR + own,x']);
    expect(result.skipped).toEqual([]);
    expect(h.dropped).toEqual([{ nicks: ['y'], limit: 2 }]);
    expect(list.status('y')).toBeUndefined();
  });

  it("keeps listed nicks ahead of new ones, and reports Lurker's that didn't fit", () => {
    const { list } = makeList();
    list.addHolder(new Holder('x', 'y'));
    list.sync([], 2);
    expect(list.sync(['own'], 2)).toEqual({ added: [], skipped: ['own'], limit: 2 });
  });

  it('starts again from nothing once the socket is gone', () => {
    const { list, sent } = makeList();
    list.sync(['a'], Infinity);
    list.reset();
    list.sync(['a'], Infinity);
    expect(sent).toEqual(['MONITOR + a', 'MONITOR + a']);
  });
});

describe('MonitorList.status', () => {
  it('is undefined off the list, null until answered, then the answer', () => {
    const { list } = makeList();
    expect(list.status('eve')).toBeUndefined();
    list.sync(['eve'], Infinity);
    expect(list.status('EVE')).toBeNull();
    list.noteStatus(['Eve'], true);
    expect(list.status('eve')).toBe(true);
    list.noteStatus(['eve'], false);
    expect(list.status('eve')).toBe(false);
  });

  it('ignores answers for nicks that are not listed', () => {
    const { list } = makeList();
    list.noteStatus(['stranger'], true);
    expect(list.status('stranger')).toBeUndefined();
  });

  it('stops adding once the network refuses a nick, until one comes off its list', () => {
    const { list, sent } = makeList();
    list.sync(['a', 'b', 'c'], Infinity);
    list.noteRefused(['c']);
    expect(list.status('c')).toBeUndefined();

    // The network is full at two, whatever it advertised.
    expect(list.sync(['a', 'b', 'c'], Infinity)).toEqual({ added: [], skipped: ['c'], limit: 2 });
    // b coming off makes room for c.
    list.sync(['a', 'c'], Infinity);
    expect(sent).toEqual(['MONITOR + a,b,c', 'MONITOR - b', 'MONITOR + c']);
    // A new socket has only the advertised limit again.
    list.reset();
    expect(list.sync(['a', 'b', 'c'], Infinity).limit).toBe(Infinity);
  });

  it("caps at the refused nick's slot, whatever came off the list since", () => {
    const { list } = makeList();
    list.sync(['a'], Infinity);
    list.sync(['a', 'b'], Infinity); // b goes on second, and will be refused
    list.sync(['b'], Infinity); // a comes off before the 734 arrives
    list.noteRefused(['b']);
    // The network held one of ours when it refused b, and a has come off since.
    expect(list.sync(['c'], Infinity).added).toEqual(['c']);
  });

  it('tells a holder the lower limit once the network has refused a nick', () => {
    const { list } = makeList();
    const h = new Holder('x', 'y');
    list.addHolder(h);
    list.sync([], Infinity);
    list.noteRefused(['y']);
    list.sync([], Infinity);
    expect(h.dropped).toEqual([{ nicks: ['y'], limit: 1 }]);
  });
});

describe('MonitorList.requestStatus', () => {
  it('is asked for by a sync that adds nicks, and not by one that adds none', async () => {
    const { list, sent } = makeList();
    list.sync(['a'], Infinity);
    await Promise.resolve();
    list.sync(['a'], Infinity);
    await Promise.resolve();
    expect(sent).toEqual(['MONITOR + a', 'MONITOR S']);
  });

  it('sends one MONITOR S at the end of the turn, however often it is asked', async () => {
    const { list, sent } = makeList();
    list.sync(['a'], Infinity);
    await Promise.resolve();
    list.requestStatus();
    list.requestStatus();
    expect(sent).toEqual(['MONITOR + a', 'MONITOR S']);
    await Promise.resolve();
    expect(sent).toEqual(['MONITOR + a', 'MONITOR S', 'MONITOR S']);
  });

  it('asks for nothing once the list has gone with its socket', async () => {
    const { list, sent } = makeList();
    list.sync(['a'], Infinity);
    list.requestStatus();
    list.reset();
    await Promise.resolve();
    expect(sent).toEqual(['MONITOR + a']);
  });
});

describe('packTargets', () => {
  it('starts a new comma list at the byte budget', () => {
    expect(packTargets(['aaaa', 'bbbb', 'cc'], 9)).toEqual(['aaaa,bbbb', 'cc']);
  });

  it('gives a nick longer than the budget a list of its own', () => {
    expect(packTargets(['toolongnick', 'a'], 4)).toEqual(['toolongnick', 'a']);
  });
});
