// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CTCP (Client-To-Client Protocol) helpers — pure wire-format + display logic,
// kept out of ircConnection so the parsing/reply rules are unit-testable on
// their own. CTCP is the `\x01TYPE args\x01`-framed sub-protocol that rides
// PRIVMSG (requests) and NOTICE (replies); ACTION (/me) is the one CTCP type
// Lurker already handled as a normal message, the rest land here.
//
// References cloned for parity (see ~/Coding/irc-clients): irssi
// (src/irc/core/ctcp.c — the auto-reply set + PING flood guard), WeeChat
// (src/plugins/irc/irc-ctcp.c — CLIENTINFO/SOURCE/TIME templates), and The
// Lounge (server/plugins/irc-events/ctcp.ts — the same irc-framework
// `version:false` + manual-reply approach we use).

/** Where Lurker's source lives — the default CTCP SOURCE reply. */
export const CTCP_SOURCE = 'https://github.com/amiantos/lurker';

// The CTCP request types we can answer. CLIENTINFO advertises the currently
// ENABLED subset (a per-type template that's non-empty); ACTION + PING are
// always handled (ACTION as a message, PING as a harmless echo) so they're
// always advertised.
export const CTCP_SUPPORTED = [
  'ACTION',
  'CLIENTINFO',
  'PING',
  'SOURCE',
  'TIME',
  'VERSION',
] as const;

/**
 * Per-user CTCP auto-reply config (read from the settings registry cell-side).
 * `enabled` is the master switch — off answers nothing, including PING. The rest
 * are WeeChat-style reply TEMPLATES: a non-empty string is the reply (with
 * `${...}` placeholders expanded — see expandCtcpTemplate), an empty string
 * disables that type.
 */
export interface CtcpReplyConfig {
  enabled: boolean;
  version: string;
  time: string;
  source: string;
  clientinfo: string;
}

/** Defaults — the all-on, WeeChat-flavored templates. */
export const CTCP_DEFAULT_CONFIG: CtcpReplyConfig = {
  enabled: true,
  version: '${name} ${version}',
  time: '${time}',
  source: '${source}',
  clientinfo: '${clientinfo}',
};

/** Placeholders a reply template may use, with what each expands to. The caller
 *  (ircConnection) supplies the live values; documented here so /set and the
 *  Settings UI can describe them. */
export const CTCP_TEMPLATE_VARS: Readonly<Record<string, string>> = Object.freeze({
  name: 'the client name ("Lurker")',
  version: 'Lurker version (e.g. 1.0.6)',
  source: 'Lurker project URL',
  clientinfo: 'space-separated list of CTCP types currently answered',
  time: 'current server time',
  nick: 'your current nick on this network',
});

/** Expand `${key}` placeholders in a template from `vars`. Unknown keys are left
 *  literal so a typo is visible rather than silently blank. */
export function expandCtcpTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

/** The CTCP types CLIENTINFO advertises given the active config: ACTION + PING
 *  always, plus each type whose template is non-empty. Sorted for a stable
 *  wire string. */
export function enabledCtcpTypes(config: CtcpReplyConfig): string[] {
  const types = ['ACTION', 'PING'];
  if (config.version.trim()) types.push('VERSION');
  if (config.time.trim()) types.push('TIME');
  if (config.source.trim()) types.push('SOURCE');
  if (config.clientinfo.trim()) types.push('CLIENTINFO');
  return types.toSorted();
}

// irssi parity (ctcp.c): refuse to echo back an oversized PING payload so a peer
// can't turn our auto-reply into a reflection/flood amplifier.
const PING_MAX_PAYLOAD = 100;

// A sane CTCP PING round trip is well under an hour; anything outside [0, 1h] is
// clock skew or a payload that wasn't our timestamp, so we show the raw reply
// instead of a nonsense latency.
const PING_MAX_PLAUSIBLE_MS = 3_600_000;

// A CTCP reply is a single IRC line framed by 0x01 — strip anything that would
// break that: CR/LF/NUL (split the IRC line) and 0x01 itself (an embedded one
// would split the reply into extra CTCP segments for the peer). A crafted/
// rebranded template therefore can't smuggle a second wire command. Filtered by
// char code (no control chars in source, keeping the linter + grep happy) and
// in one pass (no O(n²) concat on long templates).
function stripCtcpControlChars(s: string): string {
  return [...s]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c !== 0x00 && c !== 0x01 && c !== 0x0a && c !== 0x0d;
    })
    .join('');
}

/** Split a CTCP inner body (`"VERSION"` / `"PING 1719500000000"`) into an
 *  upper-cased type and the remaining argument string. */
export function parseCtcp(message: string): { type: string; args: string } {
  const trimmed = message.trim();
  const sp = trimmed.indexOf(' ');
  if (sp === -1) return { type: trimmed.toUpperCase(), args: '' };
  return { type: trimmed.slice(0, sp).toUpperCase(), args: trimmed.slice(sp + 1) };
}

function ctcpTemplateFor(type: string, config: CtcpReplyConfig): string | undefined {
  switch (type) {
    case 'VERSION':
      return config.version;
    case 'TIME':
      return config.time;
    case 'SOURCE':
      return config.source;
    case 'CLIENTINFO':
      return config.clientinfo;
    default:
      return undefined;
  }
}

/**
 * Build the auto-reply for an inbound CTCP request, or null when we don't answer
 * it (master off, unsupported type, or an empty/disabled template). The returned
 * value is the params AFTER the type; the caller frames it as
 * `ctcpResponse(nick, type, reply)`. `config` is the user's reply config and
 * `vars` supplies the live `${...}` values for template expansion — both
 * required (the templates are inert without their values; see
 * CTCP_DEFAULT_CONFIG for the default templates and CTCP_TEMPLATE_VARS for the
 * placeholder set the caller must populate).
 */
export function buildCtcpReply(
  type: string,
  args: string,
  config: CtcpReplyConfig,
  vars: Record<string, string>,
): string | null {
  // Master switch off → publish nothing, not even a PING echo.
  if (!config.enabled) return null;
  const t = type.toUpperCase();
  if (t === 'PING') {
    // Echo the payload verbatim (that's what makes round-trip timing work for
    // the requester), but drop an abusive one. PING can't be templated — it has
    // to mirror the asker's token — but the master switch still silences it.
    if (args.length > PING_MAX_PAYLOAD) return null;
    return args;
  }
  const template = ctcpTemplateFor(t, config);
  if (template === undefined) return null; // unsupported type
  if (!template.trim()) return null; // empty template = disabled
  const reply = stripCtcpControlChars(expandCtcpTemplate(template, vars)).trim();
  return reply || null;
}

/** Locale-free local-ish timestamp for a CTCP TIME reply (RFC-1123 / UTC). */
export function formatCtcpTime(now: Date): string {
  return now.toUTCString();
}

/**
 * Latency in ms for an inbound CTCP PING *reply*, derived from the echoed
 * payload (we send `PING <epoch-ms>`; a well-behaved peer echoes it back), or
 * null if the payload isn't our timestamp / the delta is implausible. The first
 * whitespace-token is used so a `sec usec` style payload degrades to "show raw"
 * rather than misreporting.
 */
export function pingReplyLatencyMs(payload: string, nowMs: number): number | null {
  const first = payload.trim().split(/\s+/)[0];
  const t = Number(first);
  if (!Number.isFinite(t) || first === '') return null;
  const ms = nowMs - t;
  if (ms < 0 || ms > PING_MAX_PLAUSIBLE_MS) return null;
  return ms;
}

/** Render a latency as seconds with 3 decimals ("0.123s"), like irssi/WeeChat. */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

/** Display line for an inbound CTCP *reply* (someone answered our query).
 *  `nowMs` lets PING report a round-trip latency from the echoed timestamp. */
export function formatCtcpReplyLine(
  nick: string,
  type: string,
  args: string,
  nowMs: number,
): string {
  const t = type.toUpperCase();
  if (t === 'PING') {
    const ms = pingReplyLatencyMs(args, nowMs);
    if (ms != null) return `CTCP PING reply from ${nick}: ${formatLatency(ms)}`;
  }
  const tail = args ? `: ${args}` : '';
  return `CTCP ${t} reply from ${nick}${tail}`;
}

/** Display line for an inbound CTCP *request* (someone probed us), showing what
 *  we disclosed back: `reply` is the answer we sent, or null when we declined
 *  (unsupported type / disabled). WeeChat shows the sent reply on its own line
 *  (irc.look.display_ctcp_reply); we fold it into the one probe line to keep the
 *  buffer quiet while still surfacing exactly what was disclosed. */
export function formatCtcpRequestLine(nick: string, type: string, reply: string | null): string {
  const base = requestLineBase(nick, type);
  return reply === null ? `${base} (no reply)` : `${base} (replied: ${reply})`;
}

/** Display line for an inbound CTCP request left to the IRC clients attached
 *  through the bouncer, which answer it in Lurker's place (#932). */
export function formatCtcpForwardedLine(nick: string, type: string): string {
  return `${requestLineBase(nick, type)} (forwarded to your IRC client)`;
}

function requestLineBase(nick: string, type: string): string {
  return `${nick} requested CTCP ${type.toUpperCase()}`;
}

// ─── Who answers, with IRC clients attached through the bouncer (#932) ──────
// One side answers a request, as in ZNC. A client's VERSION reply says Lurker
// carried it. References: ZNC's IRCSock.cpp:550 (who answers) and
// Client.cpp:1378 (" via ZNC"); irssi's proxy/listen.c:533 lets one side answer
// too. soju answers nothing.

// U+0001, which frames a CTCP inside a PRIVMSG or NOTICE. Built from its code so
// no control character sits in the source.
const CTCP_DELIM = String.fromCharCode(0x01);

/**
 * Who answers a CTCP request of a type Lurker can answer:
 * - `lurker`: Lurker answers from the user's settings, or stays silent, and no
 *   attached client is sent the request;
 * - `clients`: the attached clients are sent it, and Lurker doesn't answer;
 * - `nobody`: the asker is over its limit, so neither happens.
 */
export type CtcpAnswerer = 'lurker' | 'clients' | 'nobody';

// Each templated type's reply setting. PING has none.
const CTCP_TEMPLATE_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  VERSION: 'ctcp.version',
  TIME: 'ctcp.time',
  SOURCE: 'ctcp.source',
  CLIENTINFO: 'ctcp.clientinfo',
});

/** Every setting ctcpAnsweredBySettings reads. */
export const CTCP_ANSWER_SETTINGS: readonly string[] = [
  'ctcp.replies',
  ...Object.values(CTCP_TEMPLATE_SETTINGS),
];

/** Whether Lurker has an answer for this request type (buildCtcpReply). */
export function isAnswerableCtcp(type: string): boolean {
  const t = type.toUpperCase();
  return t === 'PING' || Object.prototype.hasOwnProperty.call(CTCP_TEMPLATE_SETTINGS, t);
}

/**
 * Whether the user's settings keep a request Lurker's even with an IRC client
 * attached: they turned replies off, or changed that type's reply. A reply ZNC
 * is given keeps the request from its clients the same way. `changed` holds the
 * keys the user changed (settingsService.changedSettings).
 */
export function ctcpAnsweredBySettings(type: string, changed: ReadonlySet<string>): boolean {
  if (changed.has('ctcp.replies')) return true;
  const key = CTCP_TEMPLATE_SETTINGS[type.toUpperCase()];
  return key !== undefined && changed.has(key);
}

/**
 * The CTCP a PRIVMSG's text carries, or null for plain text. Framed the way
 * irc-framework frames a request (messaging.js: U+0001 first and last), so this
 * and its 'ctcp request' event agree on what is one.
 */
export function ctcpInText(text: string): { type: string; args: string } | null {
  if (!text.startsWith(CTCP_DELIM) || !text.endsWith(CTCP_DELIM)) return null;
  return parseCtcp(text.slice(1, -1));
}

/**
 * A client's CTCP reply with ` via <via>` added when it answers VERSION, as ZNC
 * adds itself. Any other text comes back as it was. A reply missing its closing
 * U+0001 gets one, as ZNC frames the text again.
 */
export function ctcpVersionVia(text: string, via: string): string {
  if (!text.startsWith(CTCP_DELIM)) return text;
  const closed = text.length > 1 && text.endsWith(CTCP_DELIM);
  const body = closed ? text.slice(1, -1) : text.slice(1);
  if (parseCtcp(body).type !== 'VERSION') return text;
  return `${CTCP_DELIM}${body} via ${via}${CTCP_DELIM}`;
}
