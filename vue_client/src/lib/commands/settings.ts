// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Argument parsing, coercion, and display for the /set and /get commands (#357)
// — a single pair that operates over the whole settings registry, so the GUI
// panes and the commands are two front-ends over one source (per #353). As
// settings are added to the registry the commands cover them automatically.
//
// Pure (no store, no Vue): operates on a SettingOption handed in by the caller,
// so it unit-tests in isolation. The SFC's runSet/runGet resolve the key against
// the registry (respecting edition visibility) and apply via the settings store.

import type { SettingOption, SettingValue } from '../../../../shared/settingsRegistry.js';

const BOOL_TRUE = new Set(['true', 'on', 'yes', '1']);
const BOOL_FALSE = new Set(['false', 'off', 'no', '0']);

/** The shape of a /set invocation, before the key is resolved against the registry. */
export type SetArgs =
  | { kind: 'list' }
  | { kind: 'pair'; key: string; rawValue: string }
  | { kind: 'keyonly'; key: string };

// Strip one layer of matching surrounding quotes, so `/set k "a b"` stores `a b`
// rather than the quotes. A value that's only quoted on one side is left as-is.
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse the /set argument string into a shape. The value is "the rest of the
 * line" after the key (irssi's /set convention), so spaces and commas need no
 * quoting; an outer pair of quotes is stripped for the spaces-with-trim case.
 *
 * - empty or `?` → list all keys
 * - `<key>` alone → keyonly (the caller reports usage / suggests /get)
 * - `<key> <value…>` → pair
 */
export function splitSetArgs(argLine: string): SetArgs {
  const trimmed = argLine.trim();
  if (!trimmed || trimmed === '?') return { kind: 'list' };
  const sp = trimmed.search(/\s/);
  if (sp === -1) return { kind: 'keyonly', key: trimmed };
  const key = trimmed.slice(0, sp);
  const rawValue = stripQuotes(trimmed.slice(sp + 1).trim());
  return { kind: 'pair', key, rawValue };
}

/** Coerce a raw string into the typed value a setting expects, per its type. */
export function coerceSettingValue(
  opt: SettingOption,
  raw: string,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  switch (opt.type) {
    case 'bool': {
      const v = raw.trim().toLowerCase();
      if (BOOL_TRUE.has(v)) return { ok: true, value: true };
      if (BOOL_FALSE.has(v)) return { ok: true, value: false };
      return { ok: false, error: `${opt.key} expects a boolean (on/off, true/false, yes/no, 1/0)` };
    }
    case 'int': {
      const n = Number(raw.trim());
      if (!Number.isInteger(n)) return { ok: false, error: `${opt.key} expects an integer` };
      if (n < opt.min || n > opt.max) {
        return { ok: false, error: `${opt.key} must be between ${opt.min} and ${opt.max}` };
      }
      return { ok: true, value: n };
    }
    case 'enum': {
      if (!opt.choices.includes(raw)) {
        return { ok: false, error: `${opt.key} must be one of: ${opt.choices.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'string-list': {
      const list = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { ok: true, value: list };
    }
    case 'string':
    case 'color':
    case 'secret':
      return { ok: true, value: raw };
    default: {
      // Compile-time exhaustiveness: add a SettingType without a case above and
      // `opt` is no longer `never`, so this assignment fails to build.
      const unhandled: never = opt;
      return { ok: false, error: `${String(unhandled)}: unsupported setting type` };
    }
  }
}

/**
 * Render a setting's value for display in /get and the /set listing. Secrets are
 * masked to `(set)`/`(unset)` so they never land in a buffer or input history;
 * lists join with commas; empty strings/lists read as `(empty)`.
 */
export function formatSettingValue(opt: SettingOption, value: SettingValue | undefined): string {
  if (opt.type === 'secret') {
    return typeof value === 'string' && value.length > 0 ? '(set)' : '(unset)';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(empty)';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined) return '(unset)';
  const s = String(value);
  if (s === '') return '(empty)';
  // An enum with prose labels reads as its id here, with the label in parens —
  // the reverse of the Settings pane, and deliberately. The id is what you have
  // to TYPE back to `/set`, so it stays the value; the label is only there so
  // someone who saw "Hide all" in the GUI can tell it is this same setting.
  if (opt.type === 'enum') {
    const label = opt.choiceLabels?.[s];
    if (label && label !== s) return `${s} (${label})`;
  }
  return s;
}
