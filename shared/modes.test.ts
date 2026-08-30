// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  classifyModeChange,
  isChurnMode,
  modeLetter,
  modeTargets,
  smartHidesMode,
  type ModeChange,
} from './modes.js';

// solanum's actual shape: `q` is a quiet LIST mode and is absent from PREFIX.
const SOLANUM_PREFIX = new Set(['o', 'v']);
const SOLANUM_LIST = new Set(['e', 'I', 'b', 'q']);

// UnrealIRCd-shaped: `q` IS an owner prefix here, and not a list mode.
const UNREAL_PREFIX = new Set(['q', 'a', 'o', 'h', 'v']);
const UNREAL_LIST = new Set(['b', 'e', 'I']);

describe('modeLetter', () => {
  it('strips a leading sign', () => {
    expect(modeLetter('+o')).toBe('o');
    expect(modeLetter('-b')).toBe('b');
  });

  it('passes an unsigned token through rather than eating its first character', () => {
    // irc-framework always signs its tokens, but slicing blindly would turn a
    // malformed `o` into the empty letter — which classifies as a channel flag
    // and would then be tracked as one. Letting it through keeps the letter
    // meaningful, and keeps this function agreeing with its callers.
    expect(modeLetter('o')).toBe('o');
  });
});

describe('classifyModeChange', () => {
  it('classifies a member-status change with a param as prefix', () => {
    expect(classifyModeChange({ mode: '+o', param: 'alice' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe(
      'prefix',
    );
    expect(classifyModeChange({ mode: '-v', param: 'bob' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe(
      'prefix',
    );
  });

  it('routes solanum +q to list, even with a bare nick as its param (#486)', () => {
    // The case a hardcoded q/a/o/h/v set got wrong: on solanum a quiet's mask
    // can be a plain nick, so `+q troll` looks exactly like an owner grant and
    // is nothing of the sort.
    expect(classifyModeChange({ mode: '+q', param: 'troll' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe(
      'list',
    );
  });

  it('routes the same +q to prefix when the server declares it in PREFIX', () => {
    expect(classifyModeChange({ mode: '+q', param: 'owner' }, UNREAL_PREFIX, UNREAL_LIST)).toBe(
      'prefix',
    );
  });

  it('classifies bans and exceptions as list', () => {
    expect(
      classifyModeChange({ mode: '+b', param: '*!*@host' }, SOLANUM_PREFIX, SOLANUM_LIST),
    ).toBe('list');
    expect(
      classifyModeChange({ mode: '-e', param: '*!*@host' }, SOLANUM_PREFIX, SOLANUM_LIST),
    ).toBe('list');
  });

  it('classifies channel flags and parameter modes as chan', () => {
    expect(classifyModeChange({ mode: '+m' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe('chan');
    expect(classifyModeChange({ mode: '+k', param: 'hunter2' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe(
      'chan',
    );
    expect(classifyModeChange({ mode: '+l', param: '50' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe(
      'chan',
    );
  });

  it('does not call a param-less member mode a prefix change', () => {
    // A bare `+o` with no argument is malformed. The handler has always fallen
    // through and tracked it as a channel flag; the classifier has to agree, or
    // the row is filtered as one thing and applied as another.
    expect(classifyModeChange({ mode: '+o' }, SOLANUM_PREFIX, SOLANUM_LIST)).toBe('chan');
  });

  it('falls back to chan on an empty ISUPPORT rather than throwing', () => {
    expect(classifyModeChange({ mode: '+o', param: 'alice' }, new Set(), new Set())).toBe('chan');
  });
});

const prefix = (mode: string, param: string): ModeChange => ({ mode, param, kind: 'prefix' });

describe('isChurnMode', () => {
  it('is true for a message of nothing but member-status changes', () => {
    expect(isChurnMode([prefix('+o', 'alice')])).toBe(true);
    expect(isChurnMode([prefix('+o', 'alice'), prefix('-v', 'bob')])).toBe(true);
  });

  it('is false when anything else rides along — the whole-message gate', () => {
    // `+o-b alice *!*@host` must show in full. This is the rule that stops the
    // filter from swallowing a ban because an op change shared its line.
    expect(isChurnMode([prefix('+o', 'alice'), { mode: '-b', param: '*!*@h', kind: 'list' }])).toBe(
      false,
    );
    expect(isChurnMode([prefix('+o', 'alice'), { mode: '+m', kind: 'chan' }])).toBe(false);
  });

  it('is false for a bare ban, key or flag', () => {
    expect(isChurnMode([{ mode: '+b', param: '*!*@h', kind: 'list' }])).toBe(false);
    expect(isChurnMode([{ mode: '+k', param: 'hunter2', kind: 'chan' }])).toBe(false);
    expect(isChurnMode([{ mode: '+m', kind: 'chan' }])).toBe(false);
  });

  it('is false for an unstamped row, so old backlog shows rather than hiding', () => {
    // Rows written before the server stamped `kind`. Fail-visible: no class
    // means no filtering, not "assume it was churn".
    expect(isChurnMode([{ mode: '+o', param: 'alice' }])).toBe(false);
  });

  it('is false for an empty or missing change list', () => {
    expect(isChurnMode([])).toBe(false);
    expect(isChurnMode(null)).toBe(false);
    expect(isChurnMode(undefined)).toBe(false);
  });

  it('is false for a prefix entry that somehow lost its param', () => {
    expect(isChurnMode([{ mode: '+o', kind: 'prefix' }])).toBe(false);
  });
});

describe('modeTargets', () => {
  it('returns the nicks a message acted on, in order', () => {
    expect(
      modeTargets([
        { mode: '+o', param: 'alice', kind: 'prefix' },
        { mode: '+o', param: 'bob', kind: 'prefix' },
        { mode: '-v', param: 'carol', kind: 'prefix' },
      ]),
    ).toEqual(['alice', 'bob', 'carol']);
  });

  it('never returns a ban mask or a channel key as if it were a nick', () => {
    expect(
      modeTargets([
        { mode: '+b', param: '*!*@host', kind: 'list' },
        { mode: '+k', param: 'hunter2', kind: 'chan' },
      ]),
    ).toEqual([]);
  });

  it('returns nothing for an unstamped or empty list', () => {
    expect(modeTargets([{ mode: '+o', param: 'alice' }])).toEqual([]);
    expect(modeTargets(null)).toEqual([]);
  });
});

describe('smartHidesMode', () => {
  // A speaker set standing in for "spoke inside the window ending at this
  // event" — the comparison each client owns.
  const spoken = (...nicks: string[]) => {
    const set = new Set(nicks.map((n) => n.toLowerCase()));
    return (nick: string) => set.has(nick.toLowerCase());
  };
  const none = () => false;

  it('hides an op grant on someone nobody was talking to', () => {
    expect(smartHidesMode([prefix('+o', 'lurker')], 'ChanServ', 'me', none)).toBe(true);
  });

  it('shows it when the target spoke recently — the target, not the author', () => {
    // ChanServ never speaks in the channel. Keying on the author would hide
    // every mode change on the network; keying on the target is what makes the
    // rung mean anything. This is the test that would have caught halloy's shape.
    expect(smartHidesMode([prefix('+o', 'alice')], 'ChanServ', 'me', spoken('alice'))).toBe(false);
    // …and the author speaking is NOT what saves it.
    expect(smartHidesMode([prefix('+o', 'alice')], 'ChanServ', 'me', spoken('ChanServ'))).toBe(
      true,
    );
  });

  it('shows a mode we set ourselves', () => {
    expect(smartHidesMode([prefix('+o', 'lurker')], 'me', 'me', none)).toBe(false);
    expect(smartHidesMode([prefix('+o', 'lurker')], 'ME', 'me', none)).toBe(false);
  });

  it('shows a mode set on us', () => {
    expect(smartHidesMode([prefix('+o', 'me')], 'ChanServ', 'me', none)).toBe(false);
    expect(smartHidesMode([prefix('+o', 'Me')], 'ChanServ', 'me', none)).toBe(false);
  });

  it('shows a multi-target message when any one target spoke', () => {
    // `+ooo a b c` where only b spoke. Hiding it would drop a and c's grants on
    // the floor, so the whole row survives.
    const modes = [prefix('+o', 'a'), prefix('+o', 'b'), prefix('+o', 'c')];
    expect(smartHidesMode(modes, 'ChanServ', 'me', spoken('b'))).toBe(false);
    expect(smartHidesMode(modes, 'ChanServ', 'me', none)).toBe(true);
  });

  it('never hides a message that carries a ban, key or channel flag', () => {
    expect(
      smartHidesMode(
        [prefix('+o', 'lurker'), { mode: '-b', param: '*!*@h', kind: 'list' }],
        'ChanServ',
        'me',
        none,
      ),
    ).toBe(false);
    expect(smartHidesMode([{ mode: '+b', param: '*!*@h', kind: 'list' }], 'op', 'me', none)).toBe(
      false,
    );
    expect(smartHidesMode([{ mode: '+m', kind: 'chan' }], 'op', 'me', none)).toBe(false);
  });

  it('never hides an unstamped row', () => {
    expect(smartHidesMode([{ mode: '+o', param: 'lurker' }], 'ChanServ', 'me', none)).toBe(false);
  });

  it('still filters when our own nick is unknown', () => {
    // A buffer with no resolved self nick shouldn't stop the rung working; it
    // just loses the two "it's about me" exemptions.
    expect(smartHidesMode([prefix('+o', 'lurker')], 'ChanServ', null, none)).toBe(true);
  });
});
