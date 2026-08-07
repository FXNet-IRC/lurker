// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { CONSOLIDATABLE_TYPES } from './consolidate.js';
import {
  EVENT_MODES,
  EVENT_MODE_KEY,
  EVENT_MODE_KEY_MOBILE,
  NOISE_TYPES,
  asEventMode,
  asPageUnit,
  countsTowardPage,
  eventModeKey,
  isNoiseType,
  pageUnitFor,
} from './eventFilter.js';
import { REGISTRY, CATEGORIES } from './settingsRegistry.js';

describe('the noise set', () => {
  it('is everything consolidation folds, plus mode', () => {
    expect(NOISE_TYPES).toEqual(new Set([...CONSOLIDATABLE_TYPES, 'mode']));
  });

  it('spares the event types that carry information rather than churn', () => {
    // A reader asking for no event noise wants a quieter buffer, not one that
    // lies about what happened. Being kicked, a topic change, and an invite
    // addressed to you all survive every tier.
    for (const type of ['kick', 'topic', 'invite', 'error', 'message', 'action', 'notice']) {
      expect(isNoiseType(type)).toBe(false);
    }
  });

  it('hides presence churn and mode changes', () => {
    for (const type of ['join', 'part', 'quit', 'nick', 'chghost', 'mode']) {
      expect(isNoiseType(type)).toBe(true);
    }
  });
});

describe('tier resolution', () => {
  it('reads the mobile key on mobile and the desktop key otherwise', () => {
    expect(eventModeKey(true)).toBe(EVENT_MODE_KEY_MOBILE);
    expect(eventModeKey(false)).toBe(EVENT_MODE_KEY);
  });

  it('falls back to `all` for anything unrecognized', () => {
    // Stored values arrive from a DB row and the wire, neither of which is
    // guaranteed to have been written by this version. Degrading to today's
    // behavior beats throwing inside a render pass.
    for (const bad of [undefined, null, '', 'smart-ish', 42, true]) {
      expect(asEventMode(bad)).toBe('all');
    }
    for (const mode of EVENT_MODES) expect(asEventMode(mode)).toBe(mode);
  });

  it('exposes both tier keys as enum settings with matching choices', () => {
    // Drift guard: the tier's values live in two places by necessity (the
    // registry validates writes, this module drives rendering).
    for (const key of [EVENT_MODE_KEY, EVENT_MODE_KEY_MOBILE]) {
      const opt = REGISTRY.find((o) => o.key === key);
      expect(opt?.type).toBe('enum');
      expect(opt?.type === 'enum' && opt.choices).toEqual([...EVENT_MODES]);
      expect(opt?.default).toBe('all');
    }
  });

  it('has retired the standalone smart-filter switch', () => {
    expect(REGISTRY.find((o) => o.key === 'chat.smart_filter')).toBeUndefined();
  });

  /// The tier's values stay ids and its wording lives in `choiceLabels`. Renaming
  /// a stored enum value to improve wording would be a migration paid for in
  /// orphaned rows — the same trap `chat.image_modal.enabled` documents.
  it('labels the tier choices without renaming the stored values', () => {
    for (const key of [EVENT_MODE_KEY, EVENT_MODE_KEY_MOBILE]) {
      const opt = REGISTRY.find((o) => o.key === key);
      expect(opt?.type === 'enum' && opt.choiceLabels).toEqual({
        all: 'No filter',
        smart: 'Smart filter',
        none: 'Hide all',
      });
    }
  });

  /// Every event setting lives in its own category, in narrowing order: the
  /// filter, then how survivors are folded, then the tuning for the one rung
  /// that needs it. Registry order IS render order, so this pins both.
  it('collects every event setting into the Events category, in narrowing order', () => {
    const events = REGISTRY.filter((o) => o.category === 'events');
    expect(events.map((o) => o.key)).toEqual([
      'chat.events',
      'chat.events.mobile',
      'chat.consolidate_joins',
      'chat.consolidate_max_names',
      'chat.show_event_host',
      'chat.show_join_account',
      'chat.smart_filter_delay',
      'chat.smart_filter_join',
      'chat.smart_filter_quit',
      'chat.smart_filter_nick',
      'chat.smart_filter_join_unmask',
    ]);
    expect([...new Set(events.map((o) => o.group))]).toEqual([
      'event-filter',
      'consolidate',
      'smart-filter',
    ]);
    // The category has to exist in the sidebar, or the pane is unreachable.
    expect(CATEGORIES.find((c) => c.id === 'events')).toEqual({
      id: 'events',
      label: 'Events',
      kind: 'registry',
    });
    // ...and nothing event-shaped is left behind in Chat.
    expect(REGISTRY.filter((o) => o.category === 'chat' && o.group === 'consolidate')).toEqual([]);
  });
});

describe('page sizing', () => {
  it('matches the unit to what the client actually draws', () => {
    // The invariant the whole feature rests on: ask for a coarser unit than you
    // render and pages arrive looking empty; ask for a finer one and a single
    // page can drag in the server's entire scan window.
    expect(pageUnitFor('all', true)).toBe('renderable');
    expect(pageUnitFor('all', false)).toBe('event');
    expect(pageUnitFor('smart', true)).toBe('renderable');
    expect(pageUnitFor('smart', false)).toBe('event');
    // `none` draws nothing for any noise type, so consolidation is moot.
    expect(pageUnitFor('none', true)).toBe('chat');
    expect(pageUnitFor('none', false)).toBe('chat');
  });

  it('counts every row under `event`', () => {
    for (const type of [...NOISE_TYPES, 'message', 'kick']) {
      expect(countsTowardPage(type, 'event')).toBe(true);
    }
  });

  it('makes mode free under `chat` but not under `renderable`', () => {
    expect(countsTowardPage('mode', 'renderable')).toBe(true);
    expect(countsTowardPage('mode', 'chat')).toBe(false);
  });

  it('makes presence churn free under both of the counted units', () => {
    for (const unit of ['renderable', 'chat'] as const) {
      expect(countsTowardPage('join', unit)).toBe(false);
      expect(countsTowardPage('quit', unit)).toBe(false);
      expect(countsTowardPage('message', unit)).toBe(true);
      expect(countsTowardPage('kick', unit)).toBe(true);
    }
  });

  it('falls back to `event` for an unrecognized wire value', () => {
    // The field is additive: an older client never sends it, and a newer one
    // might send a unit this build has never heard of.
    for (const bad of [undefined, null, 'renderable-ish', 7]) {
      expect(asPageUnit(bad)).toBe('event');
    }
    expect(asPageUnit('renderable')).toBe('renderable');
    expect(asPageUnit('chat')).toBe('chat');
  });
});
