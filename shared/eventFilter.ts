// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The event-noise tier (#666) — the single primary answer to "which presence
// events survive into the message list", shared by the server (page sizing) and
// every client (rendering).
//
// Before this, the same question was spread across two independent switches
// (`chat.consolidate_joins` and `chat.smart_filter`) whose combinations a user
// had to reason about themselves, and there was no way to express "hide all of
// it" at all — the ask that motivated the tier on mobile. The tier collapses the
// primary choice to one enum; everything else in the `chat` category is a
// modifier on the survivors (how they render, how aggressive `smart` is).
//
// The tier is resolved CLIENT-side: it decides what to draw, and the server has
// no business knowing a given device's preference. The one thing the server does
// need is the page UNIT (see PageUnit below), which the client asks for.

import { CONSOLIDATABLE_TYPES } from './consolidate.js';
import { isChurnMode, type ModeChange } from './modes.js';

// ─── The tier ──────────────────────────────────────────────────────────────

/**
 * How much join/part/quit/nick/host-change/mode noise reaches the message list.
 *
 * - `all`   — every event renders (folded into summary lines when
 *             `chat.consolidate_joins` is on, which is the default).
 * - `smart`  — events render only for nicks who have recently spoken; the
 *             `chat.smart_filter_*` modifiers tune "recently" and which event
 *             kinds participate.
 * - `none`  — no event rows at all. Conversation only.
 */
export type EventMode = 'all' | 'smart' | 'none';

/** Every valid tier value, in escalating-strictness order (the UI's order too). */
export const EVENT_MODES = ['all', 'smart', 'none'] as const;

/** Registry key holding the tier for a given device class. */
export const EVENT_MODE_KEY = 'chat.events';
export const EVENT_MODE_KEY_MOBILE = 'chat.events.mobile';

/**
 * Which of the two keys a client reads. Mirrors `look.font.size` /
 * `look.font.size.mobile`: the web app switches on viewport width, and a native
 * phone client is unconditionally mobile.
 *
 * Only the TIER is device-scoped. The modifiers stay global on purpose — at
 * `none` they are all moot anyway, and nobody wants a different
 * `chat.consolidate_max_names` on their phone than on their desktop.
 */
export function eventModeKey(isMobile: boolean): string {
  return isMobile ? EVENT_MODE_KEY_MOBILE : EVENT_MODE_KEY;
}

/** Narrow an unvalidated stored/wire value to a tier, falling back to `all`. */
export function asEventMode(value: unknown): EventMode {
  return (EVENT_MODES as readonly string[]).includes(value as string)
    ? (value as EventMode)
    : 'all';
}

// ─── The noise set ─────────────────────────────────────────────────────────

/**
 * The row types `none` hides — and the set every other part of the system means
 * by "event noise", so consolidation, smart filtering, and page sizing can't
 * drift apart on the definition.
 *
 * It is CONSOLIDATABLE_TYPES plus `mode`. The two sets differ because they
 * answer different questions: CONSOLIDATABLE_TYPES is the per-identity fold set
 * AND the definition of the `renderable` page unit, while this is "what does
 * `none` hide". A reader who asked for no event noise means op/voice/ban churn
 * too — including the bans and channel flags that never fold — which is the
 * point of the tier's strictest rung.
 *
 * ⚠ `mode` being absent from CONSOLIDATABLE_TYPES does NOT mean mode rows never
 * fold. Member-status churn folds into the summary (shared/consolidate.ts,
 * foldsIntoRun); it just does so without being a member of the set that sizes
 * pages. Don't "fix" the divergence by merging them.
 *
 * ⚠ `kick`, `topic`, `invite`, `error`, `motd` and the various status lines are
 * absent here, and that is an UNDOCUMENTED DEFAULT rather than a decision
 * anyone made — they were simply never brought into the filters, and nobody has
 * revisited it. Earlier revisions of this comment asserted a principle ("things
 * that happened, not churn") as though it were settled; it wasn't. Don't cite it
 * as a reason for anything. If someone asks for these to be hidden, that is a
 * live question rather than a closed one.
 */
export const NOISE_TYPES: ReadonlySet<string> = new Set([...CONSOLIDATABLE_TYPES, 'mode']);

/** Whether a message row is event noise, i.e. hidden entirely at `none`. */
export function isNoiseType(type: string): boolean {
  return NOISE_TYPES.has(type);
}

/**
 * The row types retention's noise clock ages out early
 * (lurker-dev/RETENTION_PLAN.md §3.3) — a STORAGE set, deliberately separate
 * from the display sets above: what a reader wants hidden and what is worth
 * disk forever are different questions with overlapping answers.
 *
 * It is NOISE_TYPES plus the server-status row types that never reach the
 * filters at all: `motd` (re-sent on every connect — 5% of the reference
 * database by itself), `usermode`, `away`, `back`. `kick` / `topic` /
 * `invite` stay on the chat clock — not out of principle (see the NOISE_TYPES
 * caveat above) but arithmetic: they are so rare that early-pruning them
 * saves nothing, and deleting them buys risk for no bytes.
 *
 * The partial index idx_messages_noise_time and the noise-sweep statements
 * (server/db) both generate their type lists from this set. Editing it is
 * safe: ensureNoiseIndexCurrent (db/index.ts) compares the live index DDL at
 * boot and rebuilds on mismatch, so deployed databases self-heal instead of
 * crash-looping on the statements' INDEXED BY.
 */
export const EARLY_PRUNE_TYPES: ReadonlySet<string> = new Set([
  ...NOISE_TYPES,
  'motd',
  'usermode',
  'away',
  'back',
]);

// ─── Page sizing ───────────────────────────────────────────────────────────

/**
 * What a `history` request's `limit` counts. The unit a client asks for must
 * match the unit it RENDERS, or paging misbehaves in one of two directions:
 * ask for too coarse a unit and pages arrive looking empty (the netsplit
 * problem #10 fixed); too fine a unit and one page can drag in the server's
 * whole scan window.
 *
 * - `event`      — every stored row. Correct when the client renders each
 *                  event on its own line (tier `all`, consolidation off).
 * - `renderable` — rows outside CONSOLIDATABLE_TYPES. Correct when the client
 *                  FOLDS those runs into summary lines (tier `all`,
 *                  consolidation on).
 * - `chat`       — rows outside NOISE_TYPES. Correct at tier `none`, where the
 *                  client draws nothing for any of them.
 *
 * There is deliberately no unit for `smart`: which events it hides depends on
 * who spoke recently in that reader's client, which the server cannot know. A
 * `smart` reader asks for `renderable` (or `event`) and can still get a
 * short-looking page — the same pre-#10 behavior, tracked separately.
 */
export type PageUnit = 'event' | 'renderable' | 'chat';

/** Narrow an unvalidated wire value to a page unit, falling back to `event`. */
export function asPageUnit(value: unknown): PageUnit {
  return value === 'renderable' || value === 'chat' ? value : 'event';
}

/** The parts of a stored row that decide whether it spends page budget. */
export interface PageCountable {
  type: string;
  /** A `mode` row's parsed change list, when it has one. */
  modes?: readonly ModeChange[] | null;
}

/**
 * Whether a row spends page budget under the given unit. `event` counts
 * everything; the other two subtract what their client doesn't draw.
 *
 * ⚠ The invariant, and the direction that matters: the unit must be no FINER
 * than what the client renders. Counting rows that collapse to nothing is what
 * produces a page of `limit` units that draws as two lines — the reader watches
 * the buffer assemble itself while the client re-fetches (#10, and
 * docs/CLIENT_PROTOCOL.md's `countBy` section). Counting FEWER rows than are
 * drawn is harmless by comparison: the page simply renders longer than asked.
 *
 * So `renderable` subtracts member-status mode churn as well as
 * CONSOLIDATABLE_TYPES, because a folding client draws one summary line for the
 * whole run. This needs the row rather than its type alone — whether a mode row
 * is churn lives in its `modes`, and the type string can't answer it.
 *
 * A client that folds presence but NOT mode (any iOS build before the fold
 * lands) is on the safe side of this: it gets pages carrying uncounted mode
 * rows, which render as extra lines rather than missing ones.
 */
export function countsTowardPage(row: PageCountable, unit: PageUnit): boolean {
  if (unit === 'renderable') {
    if (CONSOLIDATABLE_TYPES.has(row.type)) return false;
    return !(row.type === 'mode' && isChurnMode(row.modes));
  }
  if (unit === 'chat') return !NOISE_TYPES.has(row.type);
  return true;
}

/**
 * The page unit a client should request, given its tier and whether it folds.
 * Shared so the web and native clients can't answer it differently.
 */
export function pageUnitFor(mode: EventMode, consolidate: boolean): PageUnit {
  if (mode === 'none') return 'chat';
  return consolidate ? 'renderable' : 'event';
}
