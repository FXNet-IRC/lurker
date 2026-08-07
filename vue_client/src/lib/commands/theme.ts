// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /theme command — the slash-command surface over theme presets
// (slash-command-first: the Themes section in Settings is a view over the same
// store). Pure and dependency-free like the other command parsers; the SFC's
// runTheme resolves names against the themes store and applies via REST.
//
// Theme names may contain spaces, so every name argument is "the rest of the
// line" (like /set values), with one layer of surrounding quotes stripped.

export type ThemeCommand =
  | { kind: 'list' }
  | { kind: 'apply'; name: string }
  | { kind: 'save'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'mode'; mode: 'single' | 'system' | null }
  | { kind: 'use'; slot: 'light' | 'dark'; name: string }
  | { kind: 'error'; message: string };

const APPLY = new Set(['apply', 'switch', 'load']);
const SAVE = new Set(['save']);
const DELETE = new Set(['delete', 'del', 'remove', 'rm']);
const LIST = new Set(['list', 'ls']);

const USAGE =
  'usage: /theme [list] · /theme apply <name> · /theme save <name> · /theme delete <name> · ' +
  '/theme mode [single|system] · /theme use <light|dark> <name>';

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

/** The rest of the line after the first `count` whitespace-delimited tokens. */
function restAfter(trimmed: string, count: number): string {
  let rest = trimmed;
  for (let i = 0; i < count; i++) {
    const sp = rest.search(/\s/);
    if (sp === -1) return '';
    rest = rest.slice(sp).trimStart();
  }
  return stripQuotes(rest.trim());
}

export function parseThemeCommand(argLine: string): ThemeCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };

  const verb = trimmed.split(/\s+/)[0].toLowerCase();

  if (LIST.has(verb)) return { kind: 'list' };

  if (APPLY.has(verb) || SAVE.has(verb) || DELETE.has(verb)) {
    const name = restAfter(trimmed, 1);
    if (!name) return { kind: 'error', message: `${verb} needs a theme name — ${USAGE}` };
    if (APPLY.has(verb)) return { kind: 'apply', name };
    if (SAVE.has(verb)) return { kind: 'save', name };
    return { kind: 'delete', name };
  }

  if (verb === 'mode') {
    const arg = restAfter(trimmed, 1).toLowerCase();
    if (!arg) return { kind: 'mode', mode: null };
    if (arg === 'single' || arg === 'system') return { kind: 'mode', mode: arg };
    return { kind: 'error', message: 'mode is "single" or "system"' };
  }

  if (verb === 'use') {
    const slot = (trimmed.split(/\s+/)[1] || '').toLowerCase();
    if (slot !== 'light' && slot !== 'dark') {
      return { kind: 'error', message: `use needs a slot — ${USAGE}` };
    }
    const name = restAfter(trimmed, 2);
    if (!name) return { kind: 'error', message: `use ${slot} needs a theme name — ${USAGE}` };
    return { kind: 'use', slot, name };
  }

  return { kind: 'error', message: USAGE };
}
