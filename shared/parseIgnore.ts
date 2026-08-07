// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /ignore command line (issue #301), modeled on irssi:
//
//   /ignore [-regexp|-full] [-pattern <text>] [-except] [-time <dur>]
//           [<mask>|<#channel>] [LEVELS...]
//
// Lives in shared/ so the client command handler and the server-side parity
// tests use the exact same implementation. Pure: no DOM, no clock except the
// injectable `now` for -time.

import { canonicalLevel, canonicalizeLevels, LEVEL_DEFS } from './ignoreLevels.js';

export type IgnorePatternKind = 'substr' | 'full' | 'regex';

export interface ParsedIgnore {
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: IgnorePatternKind;
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
  // true = scope the rule to the current network (-network); false (default) =
  // global, applying on every network (#350). Consumed by the command handler,
  // which maps it to a networkId; the rule payload itself is scope-agnostic.
  scopeNetwork: boolean;
  error?: string;
}

// The concrete level tokens an `ALL` rule expands to when a subtractive level
// (`ALL -PUBLIC`) is applied. Derived from the shared definitions so it never
// drifts.
const CONCRETE_LEVELS = Object.keys(LEVEL_DEFS);

const DURATION_RE =
  /^(\d+)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i;
const DURATION_MULT: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

// Cap durations at ~100 years. Beyond this `now + ms` overflows the valid Date
// range and `new Date(...).toISOString()` throws RangeError; an absurd value is
// almost always a typo, so reject it (treat as a parse error) rather than
// silently capping. A truly permanent ignore is just `-time` omitted.
const MAX_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = DURATION_RE.exec(s.trim());
  if (!m) return null;
  const mult = DURATION_MULT[(m[2] || 's').toLowerCase()];
  if (mult == null) return null;
  const ms = parseInt(m[1], 10) * mult;
  // Zero is rejected rather than taken literally: `-time 0` expires the rule at
  // the instant it is created, so it is reported as added, never matches, and —
  // having no index in the listing — can only be removed by mask until the
  // sweeper notices. A permanent ignore is `-time` omitted.
  if (ms <= 0 || !Number.isFinite(ms) || ms > MAX_DURATION_MS) return null;
  return ms;
}

// Whether a token is a bare unit word — what `-time 7 days` splits into.
function isDurationUnit(token: string): boolean {
  return DURATION_MULT[token.toLowerCase()] != null;
}

// The flags this grammar knows. `-pattern` refuses to take one as its value:
// otherwise `/ignore bob -pattern -network` stores a rule matching the literal
// text "-network" AND silently drops the scope, making global the rule the user
// had just scoped to one connection. Only known flags are refused, so a pattern
// may still begin with a dash.
const FLAGS = new Set([
  '-regexp',
  '-regex',
  '-full',
  '-word',
  '-except',
  '-network',
  '-net',
  '-global',
  '-replies',
  '-pattern',
  '-time',
]);

// Turn a duration string (e.g. "7 days", "30m") into an ISO expiry timestamp,
// or null if it doesn't parse. Same grammar as the -time flag, exported so the
// settings pane computes expiry identically to the command line.
export function durationToExpiry(s: string, now: number = Date.now()): string | null {
  const ms = parseDuration(s);
  if (ms == null) return null;
  return new Date(now + ms).toISOString();
}

// Tokenize on whitespace, but keep a "(…)" group (balanced) or a "quoted" string
// as a single token so `-pattern (a|b c)` / `-pattern "two words"` survive.
// Exported so the sibling /highlight parser shares the exact same tokenization.
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = '';
      while (i < n && s[i] !== quote) buf += s[i++];
      if (i < n) i++; // closing quote
      tokens.push(buf);
    } else if (ch === '(') {
      let depth = 0;
      let buf = '';
      while (i < n) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        buf += c;
        i++;
        if (depth === 0) break;
      }
      tokens.push(buf);
    } else {
      let buf = '';
      while (i < n && !/\s/.test(s[i])) buf += s[i++];
      tokens.push(buf);
    }
  }
  return tokens;
}

function isChannelToken(t: string): boolean {
  return /^[#&!+]/.test(t);
}

export function parseIgnoreArgs(argLine: string, now: number = Date.now()): ParsedIgnore {
  const base: ParsedIgnore = {
    mask: null,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: [],
    isExcept: false,
    expiresAt: null,
    scopeNetwork: false,
  };
  const fail = (error: string): ParsedIgnore => ({ ...base, error });

  const tokens = tokenize(argLine.trim());
  const addLevels: string[] = [];
  const subLevels: string[] = [];
  const channels: string[] = [];
  let mask: string | null = null;
  // Whether an explicit `*` (or an empty token) claimed the mask slot — "anyone",
  // said on purpose, as against never naming a subject at all.
  let sawAnyone = false;
  let sawRegexp = false;
  let sawFull = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();

    if (lower === '-regexp' || lower === '-regex') {
      sawRegexp = true;
      continue;
    }
    if (lower === '-full' || lower === '-word') {
      sawFull = true;
      continue;
    }
    if (lower === '-except') {
      base.isExcept = true;
      continue;
    }
    // Scope flags (#350). Default is global; -network/-net scopes to the current
    // network, -global is the explicit opposite (a no-op but symmetric/discoverable).
    if (lower === '-network' || lower === '-net') {
      base.scopeNetwork = true;
      continue;
    }
    if (lower === '-global') {
      base.scopeNetwork = false;
      continue;
    }
    if (lower === '-replies') return fail('-replies is not supported');
    if (lower === '-pattern') {
      const val = tokens[++i];
      if (val === undefined) return fail('-pattern needs a value');
      if (FLAGS.has(val.toLowerCase())) return fail(`-pattern needs a value (got the flag ${val})`);
      base.pattern = val;
      continue;
    }
    if (lower === '-time') {
      let val = tokens[++i];
      // `7 days` typed without quotes arrives as two tokens. Taking only the
      // first makes `/ignore -time 7 days` a SEVEN-SECOND rule whose mask is the
      // word "days" — which then lapses and leaves no trace of what happened.
      // The pair is unambiguous (a bare count followed by a unit word), so join
      // it and read the line the way it was written.
      if (
        val !== undefined &&
        /^\d+$/.test(val) &&
        tokens[i + 1] &&
        isDurationUnit(tokens[i + 1])
      ) {
        val = `${val} ${tokens[++i]}`;
      }
      const ms = parseDuration(val);
      if (ms == null) return fail(`invalid -time value: ${val ?? '(missing)'}`);
      base.expiresAt = new Date(now + ms).toISOString();
      continue;
    }

    // Subtractive level: -LEVEL where LEVEL is a known token (e.g. ALL -PUBLIC).
    if (t.startsWith('-') && t.length > 1) {
      const lvl = canonicalLevel(t.slice(1));
      if (lvl) {
        // `-ALL` reads as "everything except everything", and resolving it below
        // produces the MAXIMUM hide set: the base expands ALL to its concrete
        // members first, so the removal loop then looks for a token that is no
        // longer in the set and takes nothing off. Refuse it — `PUBLIC -PUBLIC`
        // already fails with "no levels remain", and this is the same request.
        if (lvl === 'ALL') {
          return fail("-ALL isn't a level to subtract — name what to keep, or drop the rule");
        }
        subLevels.push(lvl);
        continue;
      }
      return fail(`unknown flag: ${t}`);
    }

    if (isChannelToken(t)) {
      channels.push(t.toLowerCase());
      continue;
    }

    const lvl = canonicalLevel(t);
    if (lvl) {
      addLevels.push(lvl);
      continue;
    }

    if (mask === null && !sawAnyone) {
      // `*` is "anyone", which the matcher spells as no mask at all — and so are
      // an empty quoted token (`/ignore ""`) and a whitespace-only one
      // (`/ignore " "`), both of which `parseIgnoreInput`'s strOrNull nulls on
      // the way in. Normalizing all three here keeps the rule the client shows
      // the same as the one the server stores; `" "` previously survived as a
      // mask, was nulled server-side, and became a rule hiding everyone.
      const trimmed = t.trim();
      // Remembered, because "the user asked for everyone" and "the user named
      // nobody" both leave `mask` null and only the second is a mistake.
      if (trimmed === '*' || trimmed === '') sawAnyone = true;
      else mask = trimmed;
      continue;
    }
    return fail(`unexpected argument: ${t}`);
  }

  base.patternKind = sawRegexp ? 'regex' : sawFull ? 'full' : 'substr';
  base.mask = mask;
  base.channels = channels.length ? channels : null;
  // A whitespace-only pattern is nulled by strOrNull server-side, and a null
  // pattern WIDENS the rule from "hide what they say about X" to "hide
  // everything they say" — so trim here and treat empty as absent.
  if (base.pattern != null) {
    const trimmed = base.pattern.trim();
    base.pattern = trimmed === '' ? null : trimmed;
  }

  // Resolve the level set. Additive tokens form the base; with none given the
  // base is ALL. Subtractive tokens expand ALL to its concrete members first,
  // then remove — mirroring irssi's `ALL -PUBLIC -ACTIONS`.
  const levelSet = new Set<string>(addLevels.length ? addLevels : ['ALL']);
  if (subLevels.length) {
    if (levelSet.has('ALL')) {
      levelSet.delete('ALL');
      for (const l of CONCRETE_LEVELS) levelSet.add(l);
    }
    for (const s of subLevels) levelSet.delete(s);
  }
  if (levelSet.size === 0) return fail('no levels remain');

  // A rule that names no subject — no mask, no channel, no content — hides EVERY
  // message from everyone, on every network if it's global. That is occasionally
  // what someone means, so the escape hatch is to say it: `/ignore * JOINS` is
  // explicit and passes. What's refused is arriving there by accident, which
  // several ordinary lines do: `/ignore -network` sent by a stray Return,
  // `/ignore -time 1d`, or `/ignore Quit`, where a nick that happens to spell a
  // level token is consumed as the level (levels are read before masks) leaving
  // the rule with no subject at all. `ignoreRulesService.add` deliberately
  // declines to stop this, since by then the intent is unrecoverable.
  if (mask === null && channels.length === 0 && !base.pattern && !sawAnyone) {
    return fail(
      'that names nobody to ignore — try /ignore <nick>, or /ignore * <levels> for everyone',
    );
  }

  // A `-regexp` pattern is compiled here, where the engine is the same one the
  // matcher will use. Without it the rule reaches the server, `add` refuses it
  // ("invalid regex"), and `wsHub`'s add-ignore drops that failure with a bare
  // `break` and no reply — so an unclosed bracket looks like it worked and the
  // rule simply never exists.
  if (sawRegexp && base.pattern) {
    try {
      void new RegExp(base.pattern);
    } catch (e) {
      return fail(`invalid regex: ${(e as Error).message}`);
    }
  }

  // Canonical order + dedupe for a stable stored CSV.
  base.levels = canonicalizeLevels([...levelSet]);
  return base;
}
