// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// THE per-buffer history cap, in one place (lurker-dev/RETENTION_PLAN.md).
//
// Two values stack, and the effective cap is the smaller of the ones actually
// set:
//
//   1. the operator ceiling  LURKER_MAX_RETENTION_LINES. An env var rather
//                            than a tenant setting for the same reason
//                            LURKER_MAX_UPLOAD_MB is: it describes the
//                            deployment, and a tenant must not be able to
//                            raise it. There is deliberately no separate
//                            operator *default* — an untouched user setting
//                            resolves to unlimited and then clamps to the
//                            ceiling, so the ceiling IS the default.
//   2. the user's own        `data.retention.lines` (0 = unlimited).
//
// 0 (or unset) means "keep everything" at every layer. Every path that
// enforces or advertises a retention cap goes through effectiveRetentionLines
// so the sweeper and whatever a client is told can never disagree.

import { getUserSettings } from '../db/settings.js';
import { getBufferRetentionOverride } from '../db/bufferRetention.js';
import { defaultsAsObject } from './settingsRegistry.js';
import * as systemLog from './systemLog.js';

// Warn once per process PER VAR, not per sweep tick: a misconfiguration that
// repeats every minute is noise rather than a signal.
const warnedBadCeiling = new Set<string>();

/**
 * Parse one ceiling env var: a bare decimal integer, `0` accepted as an
 * explicit "no ceiling" spelling. Strictness is the point — Number()
 * coercions like "1.9" → 1 or "1e5" → 100000 would silently enable pruning
 * with a ceiling the operator never wrote.
 *
 * Anything unparseable falls back to NO ceiling, loudly. Fail-open is the
 * only safe direction for these knobs: a typo that resolved to some small
 * number would quietly mass-delete history that cannot be restored.
 */
function parseCeilingEnv(
  name: string,
  unit: string,
  example: string,
  max: number,
  overflow: 'clamp' | 'reject',
  consequence: string,
  minNonzero = 0,
): number | null {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    warnCeilingOnce(
      name,
      `${name}="${raw}" is not a whole number of ${unit}; ignoring it. ${consequence} ` +
        `Use a bare integer, e.g. ${example}.`,
    );
    return null;
  }
  // The upper bound is a sanity rail against extra-digit typos that survive
  // the regex. What happens on overflow differs BY CONSEQUENCE, not taste:
  // an hours value past ~275,000 years makes new Date() throw inside the
  // sweeper and the circuit breaker then stops ALL retention, so hours must
  // reject (fail open). A lines value has no date math — rejecting it would
  // silently UNBOUND an instance whose oversized-but-working ceiling was
  // enforcing before the rail existed, so lines clamp instead.
  if (value > max) {
    if (overflow === 'reject') {
      warnCeilingOnce(
        name,
        `${name}="${raw}" exceeds the maximum of ${max} ${unit}; ignoring it. ${consequence} `,
      );
      return null;
    }
    warnCeilingOnce(name, `${name}="${raw}" exceeds the maximum of ${max} ${unit}; using ${max}.`);
    return max;
  }
  // The same footgun floor the user knob carries, on the one path that
  // overrides everyone: a ceiling below it (a units mix-up, a test value left
  // in cell.env) would force-delete every account's data with no warning.
  if (value !== 0 && value < minNonzero) {
    warnCeilingOnce(
      name,
      `${name}="${raw}" is below the minimum of ${minNonzero} ${unit}; ignoring it. ${consequence}`,
    );
    return null;
  }
  return value === 0 ? null : value;
}

function warnCeilingOnce(name: string, text: string): void {
  if (warnedBadCeiling.has(name)) return;
  warnedBadCeiling.add(name);
  console.warn(`[lurker] ${text}`);
  // Also into the system buffer: "the ceiling never took effect as written"
  // is an operator-facing condition, and stdout is not an operator surface.
  systemLog.log({ level: 'warn', scope: 'server', text });
}

/** The operator's per-buffer line ceiling, or null when none is declared. */
export function declaredRetentionCeilingLines(): number | null {
  return parseCeilingEnv(
    'LURKER_MAX_RETENTION_LINES',
    'lines',
    'LURKER_MAX_RETENTION_LINES=100000',
    1_000_000_000,
    'clamp',
    // Accurate for THIS var: an untouched user resolves to unlimited, so no
    // ceiling really does mean nothing is pruned by line count.
    'History is NOT bounded by an instance ceiling.',
  );
}

export type CeilingState = 'set' | 'none' | 'invalid';

/**
 * How one ceiling env var actually resolved — for surfaces that must not let
 * an operator misread fail-open. `declared…()` returns null for three
 * different situations (unset, explicit 0, and set-but-unparseable), and the
 * admin Storage pane once rendered all three as "unset", sending an operator
 * whose value had a typo off to debug env propagation while history grew
 * unbounded.
 */
export function ceilingState(name: string, resolved: number | null): CeilingState {
  if (resolved != null) return 'set';
  const raw = (process.env[name] || '').trim();
  if (raw === '') return 'none';
  // Any all-digit zero spelling ("0", "00", …) is the explicit no-ceiling
  // form parseCeilingEnv accepts — it must not read as "invalid" here.
  return /^\d+$/.test(raw) && Number(raw) === 0 ? 'none' : 'invalid';
}

/** The operator's noise-age ceiling in hours, or null when none is declared. */
export function declaredEventRetentionCeilingHours(): number | null {
  return parseCeilingEnv(
    'LURKER_MAX_EVENT_RETENTION_HOURS',
    'hours',
    'LURKER_MAX_EVENT_RETENTION_HOURS=336',
    87_600,
    'reject',
    // Deliberately different from the lines message: ignoring THIS ceiling
    // does not stop noise pruning — every untouched user still runs the
    // 168-hour registry default. Saying "not bounded" here misled the
    // operator into thinking the noise clock was inert.
    "The noise clock still runs at each user's own setting (default 168 hours); " +
      'only the operator ceiling is missing.',
  );
}

/** The operator's closed-buffer GC ceiling in days, or null when none is
 *  declared. Fail-open on overflow like hours: a rejected ceiling means LESS
 *  deletion, which is the safe direction for a whole-buffer delete. */
export function declaredClosedBufferCeilingDays(): number | null {
  return parseCeilingEnv(
    'LURKER_MAX_CLOSED_BUFFER_DAYS',
    'days',
    'LURKER_MAX_CLOSED_BUFFER_DAYS=90',
    36_500,
    'reject',
    "Closed buffers are collected only according to each user's own setting (default: never).",
    7,
  );
}

/**
 * The effective closed-buffer GC age for this user, in days. 0 = never (the
 * registry default). Same min-of-the-nonzero stacking: a user's 0 under an
 * operator ceiling resolves to the ceiling — that is how hosted forces
 * collection without touching anyone's settings.
 */
export function effectiveClosedBufferDays(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  return clampToCeiling(
    settings['data.retention.closed_buffer_days'],
    declaredClosedBufferCeilingDays(),
  );
}

/**
 * The user's own global line cap, raw: 0 = unlimited, NO ceiling applied.
 * Split out so the sweeper can resolve it once per user per tick and hand it
 * back through effectiveRetentionLines for each of that user's buffers,
 * instead of re-reading settings per buffer.
 */
export function userRetentionLines(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  const n = Number(settings['data.retention.lines']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The effective cap for one buffer, in lines — the number the sweeper
 * actually prunes to. 0 = unlimited. Resolution: the buffer's stored
 * override (which may sit ABOVE the user's global — "keep everything here"
 * is the point), else the user's global, and the result clamps to the
 * operator ceiling — the ONE clamp site, per the header contract. Pass
 * `preResolvedUserLines` (from userRetentionLines) on hot loops; omit it and
 * this resolves the global itself.
 */
export function effectiveRetentionLines(
  userId: number,
  bufferId?: number,
  preResolvedUserLines?: number,
): number {
  const globalLines = preResolvedUserLines ?? userRetentionLines(userId);
  const override = bufferId === undefined ? null : getBufferRetentionOverride(userId, bufferId);
  const chosen = override ?? globalLines;
  return clampToCeiling(chosen, declaredRetentionCeilingLines());
}

/**
 * The effective noise-clock age for this user, in hours — rows in
 * EARLY_PRUNE_TYPES older than this are pruned regardless of the line cap.
 * 0 = the noise clock is off (events live as long as chat). Same
 * min-of-the-nonzero stacking as the line cap; the registry default (168) is
 * what an untouched user gets.
 */
export function effectiveEventRetentionHours(userId: number): number {
  const settings = { ...defaultsAsObject(), ...getUserSettings(userId) };
  return clampToCeiling(
    settings['data.retention.event_hours'],
    declaredEventRetentionCeilingHours(),
  );
}

function clampToCeiling(rawSetting: unknown, ceiling: number | null): number {
  const n = Number(rawSetting);
  const userValue = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (ceiling == null) return userValue;
  return userValue === 0 ? ceiling : Math.min(userValue, ceiling);
}
