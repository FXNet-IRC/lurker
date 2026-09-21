// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /dcc command (#270) — the slash-command surface over DCC.
// `list` opens the Transfers view; accept / reject / cancel act on one transfer
// by its numeric id (the id shown in the list); `chat` opens a direct chat with
// a peer and `close` ends one.
//
// Pure and dependency-free so it unit-tests outside the Vue SFC, like the other
// command parsers.
//
// ⚠ The transfer verbs are user-wide, but chat is per-network — it rides that
// network's connection — so the SFC has to refuse a chat verb issued from the
// network-agnostic system buffer rather than routing it with a null networkId.

export type DccCommand =
  | { kind: 'list' }
  | { kind: 'accept'; id: number }
  | { kind: 'reject'; id: number }
  | { kind: 'cancel'; id: number }
  | { kind: 'chat'; nick: string; passive: boolean }
  | { kind: 'chatClose'; nick: string }
  | { kind: 'error'; message: string };

const ACCEPT = new Set(['accept', 'ok', 'yes', 'get']);
const REJECT = new Set(['reject', 'deny', 'no']);
const CANCEL = new Set(['cancel', 'abort', 'stop']);
const LIST = new Set(['list', 'ls']);

const USAGE =
  'usage: /dcc [list] · /dcc accept|reject|cancel <id> · /dcc chat [-passive] <nick> · ' +
  '/dcc close <nick>';

// A nick is any non-whitespace token; the server does the real validation. A
// leading `=` is refused here because that is a DCC-chat BUFFER name, and
// `/dcc chat =bob` almost certainly means the user typed the buffer rather than
// the peer — accepting it would open a chat with a peer literally called "=bob".
function parseNick(raw: string | undefined): string | null {
  const n = (raw || '').trim();
  if (!n || n.startsWith('=')) return null;
  return n;
}

// Parse a positive integer transfer id, or null. Rejects empty, non-numeric, and
// non-positive values so a fat-fingered id surfaces a usage hint rather than
// POSTing to /api/dcc/NaN/accept.
function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseDccCommand(argLine: string): DccCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };

  const parts = trimmed.split(/\s+/);
  const verb = parts[0].toLowerCase();

  if (LIST.has(verb)) return { kind: 'list' };

  // `/dcc chat [-passive] <nick>` opens a chat; `/dcc chat close <nick>` and
  // `/dcc close <nick>` end one. `-passive` is spelled as irssi and repartee
  // spell it, and is opt-in rather than a fallback: WeeChat and HexDroid
  // mishandle a passive offer into a silent dial to port 0.
  if (verb === 'chat') {
    if ((parts[1] || '').toLowerCase() === 'close') {
      const nick = parseNick(parts[2]);
      return nick
        ? { kind: 'chatClose', nick }
        : { kind: 'error', message: 'usage: /dcc chat close <nick>' };
    }
    const flags = parts.slice(1).filter((p) => p.startsWith('-'));
    const rest = parts.slice(1).filter((p) => !p.startsWith('-'));
    const unknown = flags.find((f) => f.toLowerCase() !== '-passive');
    if (unknown) {
      return {
        kind: 'error',
        message: `unknown option "${unknown}". usage: /dcc chat [-passive] <nick>`,
      };
    }
    const nick = parseNick(rest[0]);
    if (!nick) return { kind: 'error', message: 'usage: /dcc chat [-passive] <nick>' };
    return { kind: 'chat', nick, passive: flags.length > 0 };
  }
  if (verb === 'close') {
    const nick = parseNick(parts[1]);
    return nick
      ? { kind: 'chatClose', nick }
      : { kind: 'error', message: 'usage: /dcc close <nick>' };
  }

  const isAccept = ACCEPT.has(verb);
  const isReject = REJECT.has(verb);
  const isCancel = CANCEL.has(verb);
  if (isAccept || isReject || isCancel) {
    const kind = isAccept ? 'accept' : isReject ? 'reject' : 'cancel';
    const id = parseId(parts[1]);
    if (id == null) return { kind: 'error', message: `usage: /dcc ${kind} <id>` };
    return { kind, id };
  }

  return { kind: 'error', message: `unknown subcommand "${parts[0]}". ${USAGE}` };
}
