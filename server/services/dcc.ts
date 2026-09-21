// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC (Direct Client-to-Client) wire parsing — pure, unit-testable in isolation,
// kept out of ircConnection just like ctcp.ts. DCC rides CTCP: a peer sends a
// `\x01DCC SEND <file> <ip> <port> <size> [token]\x01`-framed PRIVMSG, which
// reaches us as a CTCP request of type `DCC` (the rest of the body — the part
// this module parses — is `SEND <file> ...`). irc-framework gives us only the
// CTCP plumbing; the DCC grammar is ours.
//
// Handles the inbound `SEND` offer (the download manager), `ACCEPT` (the resume
// confirmation) and `CHAT`; anything else is reported as `unsupported` so the
// caller can ignore it cleanly.
//
// References cloned for parity (see ~/Coding/irc-clients): irssi
// (src/irc/dcc/dcc-get.c — the SEND param parse + IPv4/IPv6 address handling) and
// WeeChat (src/plugins/irc/irc-ctcp.c — the quoted-first / single-token-else
// filename rule). The protocol's fiddly bits: the IPv4 address is a uint32 in
// network byte order (NOT dotted-quad), a port of 0 means passive/reverse DCC and
// carries a token, and a filename with spaces must be double-quoted.
//
// ⚠ The CHAT grammar's second token (`chat`) is the "protocol" slot, and we must
// be LIBERAL about it: four of the six implementations that speak DCC CHAT never
// read it at all (irssi literally labels it `<unused>`, dcc-chat.c:622; so do
// HexChat, HexDroid and repartee). Only WeeChat validates it, case-insensitively
// (irc-ctcp.c:1349). Rejecting an unexpected value here would only lose us peers.
//
// ⚠ A port of 0 is passive ONLY when a token follows. Port 0 with no token is a
// malformed offer and must be REFUSED, never dialled — HexChat gets this right
// (dcc.c:2500-2504) and it is the one case where a naive parser tries to open a
// TCP connection to port 0.

import zlib from 'zlib';
import { isBlockedIpLiteral } from '../utils/ipGuard.js';

/** A parsed inbound `DCC SEND` offer. `host` is decoded to a dotted-quad (IPv4)
 *  or kept as an IPv6 literal; `filename` is RAW and unsanitised — path-safety is
 *  the storage layer's job, not the parser's. `passive` (port 0) means the sender
 *  is firewalled and we'd be the one to listen; `token` correlates the passive
 *  reply. `size` is the advertised byte count (can exceed 4 GiB, so it's a JS
 *  number, not a uint32). */
export interface DccSend {
  kind: 'send';
  filename: string;
  host: string;
  port: number;
  size: number;
  token: number | null;
  passive: boolean;
}

/** A parsed inbound `DCC ACCEPT` — the sender's reply to a `DCC RESUME` we sent,
 *  confirming it will resume from `position` bytes. */
export interface DccAccept {
  kind: 'accept';
  filename: string;
  port: number;
  position: number;
  token: number | null;
}

/** A parsed inbound `DCC CHAT` offer — a request to open a direct line-oriented
 *  chat. `host`/`port` are where the offerer is listening (active); `passive`
 *  (port 0) means the offerer is firewalled and wants US to listen, correlated
 *  by `token`. The `protocol` field is almost always `chat` (the only widely
 *  used subtype). */
export interface DccChat {
  kind: 'chat';
  protocol: string;
  host: string;
  port: number;
  token: number | null;
  passive: boolean;
}

/** Result of parsing a CTCP DCC body: a `SEND` offer, an `ACCEPT` (resume
 *  confirmation), a recognised-but-unhandled subtype (CHAT/RESUME/…), or a
 *  structural rejection with a reason for logging. */
export type DccParse =
  | DccSend
  | DccAccept
  | DccChat
  | { kind: 'unsupported'; subtype: string }
  | { kind: 'invalid'; reason: string };

/** Non-negative integer or null. Used for port/size/token — size may be > 2^32
 *  (files over 4 GiB) so the only ceiling is JS's safe-integer range. */
function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Decode a DCC address field to a printable host, or null if malformed. Three
 * forms are accepted:
 *  - the classic DCC IPv4-as-uint32 (network byte order), e.g. 3232235777 →
 *    "192.168.1.1" — this is what real senders use;
 *  - a dotted-quad IPv4 (some passive replies / lenient senders use it directly);
 *  - an IPv6 literal (sent verbatim, detected by its colons).
 */
export function decodeDccAddress(addr: string): string | null {
  const s = addr.trim();
  if (s === '') return null;
  // IPv6 literal — sent as-is; a colon is the giveaway (a valid v6 literal has at
  // least two). Allow the v4-mapped `::ffff:1.2.3.4` form's dot too.
  if (s.includes(':')) {
    const colons = s.match(/:/g)?.length ?? 0;
    return /^[0-9a-fA-F:.]+$/.test(s) && colons >= 2 ? s : null;
  }
  // Dotted-quad IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255) ? s : null;
  }
  // Classic DCC form: IPv4 packed into a uint32, network byte order.
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  return null;
}

/**
 * Parse the body of a CTCP DCC request — i.e. everything AFTER the `DCC` keyword,
 * such as `SEND "my file.mkv" 3232235777 50612 1024`. The caller has already
 * split `DCC` off via parseCtcp (`{ type: 'DCC', args }`), so pass `args` here.
 */
export function parseDcc(args: string): DccParse {
  const body = args.trim();
  if (body === '') return { kind: 'invalid', reason: 'empty DCC body' };
  const sp = body.indexOf(' ');
  const subtype = (sp === -1 ? body : body.slice(0, sp)).toUpperCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1).trim();
  if (subtype === 'SEND') return parseDccSend(rest);
  if (subtype === 'ACCEPT') return parseDccAccept(rest);
  if (subtype === 'CHAT') return parseDccChat(rest);
  return { kind: 'unsupported', subtype };
}

// `DCC CHAT <protocol> <ip> <port> [token]` — an offer to open a direct chat.
// `protocol` is conventionally the literal `chat`, but its value is NOT checked
// (see the ⚠ in the module header): irssi, HexChat, HexDroid and repartee all
// ignore it, so a mismatch is their business, not ours. We keep it verbatim in
// case a caller ever wants it as a hint.
//
// ⚠ Trailing junk past the token is IGNORED rather than rejected — irssi accepts
// a 5th+ field (dcc-chat.c:627 only tests `paramcount < 3`), so refusing one
// would drop offers that a real client considers well-formed.
function parseDccChat(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC CHAT parameters' };
  const fields = rest.split(/\s+/).filter(Boolean);
  if (fields.length < 3) {
    return { kind: 'invalid', reason: 'expected <protocol> <ip> <port> [token]' };
  }
  const [protocol, hostStr, portStr, tokenStr] = fields;
  const host = decodeDccAddress(hostStr);
  if (host === null) return { kind: 'invalid', reason: `bad address: ${hostStr}` };
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }
  // ⚠⚠ Port 0 means "I am firewalled, YOU listen" and is only meaningful with a
  // token to correlate the reverse reply. Port 0 with no token is malformed, and
  // the one shape a careless parser turns into a dial to port 0 — refuse it here
  // so no caller can. (HexChat does the same: dcc.c:2500-2504.)
  if (port === 0 && token === null) {
    return { kind: 'invalid', reason: 'passive DCC CHAT offer carries no token' };
  }
  return { kind: 'chat', protocol, host, port, token, passive: port === 0 };
}

// `DCC ACCEPT <filename> <port> <position> [token]` — the sender's go-ahead for a
// resume. Same filename grammar as SEND (quoted, else first token), then the port
// the original offer used and the byte position it will resume from.
function parseDccAccept(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC ACCEPT parameters' };
  let filename: string;
  let remainder: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return { kind: 'invalid', reason: 'unterminated quoted filename' };
    filename = rest.slice(1, end);
    remainder = rest.slice(end + 1).trim();
  } else {
    const fsp = rest.indexOf(' ');
    if (fsp === -1) return { kind: 'invalid', reason: 'missing port/position' };
    filename = rest.slice(0, fsp);
    remainder = rest.slice(fsp + 1).trim();
  }
  if (filename === '') return { kind: 'invalid', reason: 'empty filename' };

  const fields = remainder.split(/\s+/).filter(Boolean);
  if (fields.length < 2 || fields.length > 3) {
    return { kind: 'invalid', reason: 'expected <port> <position> [token]' };
  }
  const [portStr, posStr, tokenStr] = fields;
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  const position = parseUint(posStr);
  if (position === null) return { kind: 'invalid', reason: `bad position: ${posStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }
  return { kind: 'accept', filename, port, position, token };
}

function parseDccSend(rest: string): DccParse {
  if (rest === '') return { kind: 'invalid', reason: 'missing DCC SEND parameters' };

  let filename: string;
  let remainder: string;
  if (rest.startsWith('"')) {
    // Quoted filename — the only spec-conformant way to carry spaces.
    const end = rest.indexOf('"', 1);
    if (end === -1) return { kind: 'invalid', reason: 'unterminated quoted filename' };
    filename = rest.slice(1, end);
    remainder = rest.slice(end + 1).trim();
  } else {
    // Unquoted: the filename is the first whitespace token. A name with spaces
    // MUST be quoted per the DCC convention; XDCC bots use space-free names
    // (underscores), so first-token is correct for real traffic and keeps the
    // address/port/size fields unambiguous (WeeChat irc-ctcp.c does the same).
    const fsp = rest.indexOf(' ');
    if (fsp === -1) return { kind: 'invalid', reason: 'missing address/port/size' };
    filename = rest.slice(0, fsp);
    remainder = rest.slice(fsp + 1).trim();
  }
  if (filename === '') return { kind: 'invalid', reason: 'empty filename' };

  const fields = remainder.split(/\s+/).filter(Boolean);
  if (fields.length < 3 || fields.length > 4) {
    return { kind: 'invalid', reason: 'expected <ip> <port> <size> [token]' };
  }
  const [hostStr, portStr, sizeStr, tokenStr] = fields;

  const host = decodeDccAddress(hostStr);
  if (host === null) return { kind: 'invalid', reason: `bad address: ${hostStr}` };
  const port = parseUint(portStr);
  if (port === null || port > 65535) return { kind: 'invalid', reason: `bad port: ${portStr}` };
  const size = parseUint(sizeStr);
  if (size === null) return { kind: 'invalid', reason: `bad size: ${sizeStr}` };
  let token: number | null = null;
  if (tokenStr !== undefined) {
    token = parseUint(tokenStr);
    if (token === null) return { kind: 'invalid', reason: `bad token: ${tokenStr}` };
  }

  return { kind: 'send', filename, host, port, size, token, passive: port === 0 };
}

// ---------------------------------------------------------------------------
// Outgoing DCC CHAT — building the CTCP bodies WE send when offering a chat.
// These return the CTCP *body* (the part after `DCC`); the caller frames it as a
// CTCP request of type DCC. Pure + unit-tested.
//
// ⚠⚠ The IPv4 address MUST go out as a uint32 in network byte order, never a
// dotted quad. irssi decodes a colon-free address with `strtoul` (dcc.c:185-190),
// so `192.168.1.5` would reach it as 0.0.0.192; HexChat does the same and
// repartee refuses outright. Only WeeChat/HexDroid/halloy accept a dotted quad.
// An IPv6 offerer sends the literal, which every implementation detects by colon.
//
// ⚠ The protocol token goes out LOWERCASE (`chat`). irssi and repartee emit
// `CHAT`; everyone else emits `chat`. Nothing rejects either — WeeChat's is the
// only check and it's case-insensitive — but lowercase is what the majority
// sends and what znc's bouncedcc regenerates when it rewrites an offer.
//
// ⚠ An active offer is EXACTLY five tokens (`DCC CHAT chat <addr> <port>`).
// Never append anything: HexChat reads a 6th token on a non-zero port as the
// third leg of a passive handshake and answers `dcc_malformed` when it has no
// matching record (dcc.c:2491-2521).
// ---------------------------------------------------------------------------

/** Encode a host for a DCC offer field: IPv4 → its uint32 (network byte order)
 *  as a decimal string; an IPv6 literal is passed through verbatim (detected by
 *  a colon). Returns null if it's neither a dotted-quad nor a v6 literal. */
export function encodeDccAddress(host: string): string | null {
  const h = host.trim();
  if (h.includes(':')) {
    return /^[0-9a-fA-F:.]+$/.test(h) ? h : null;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map((x) => Number(x));
  if (o.some((x) => x > 255)) return null;
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return String(n);
}

/** Build the body of an active `DCC CHAT` offer — `CHAT chat <addr> <port>`. */
export function buildDccChat(host: string, port: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} ${port}`;
}

/** Build the body of a passive/reverse `DCC CHAT` offer —
 *  `CHAT chat <addr> 0 <token>` (the peer listens and replies). */
export function buildDccChatPassive(host: string, token: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} 0 ${token}`;
}

/** Reverse reply to a peer's PASSIVE `DCC CHAT`: our listening address/port +
 *  their token — `CHAT chat <addr> <port> <token>`. */
export function buildDccChatReverse(host: string, port: number, token: number): string | null {
  const addr = encodeDccAddress(host);
  if (addr === null) return null;
  return `CHAT chat ${addr} ${port} ${token}`;
}

/**
 * The placeholder address a PASSIVE `DCC CHAT` offer advertises. The peer is
 * meant to ignore it — they reply with the address we should dial — but it still
 * has to look like a real IPv4, because some receivers reject an unroutable one.
 * 1.1.1.1 is what irssi (dcc-chat.c:530-533) and repartee (protocol.rs:5) both
 * send; HexChat's `199` (0.0.0.199) is the outlier and is deliberately not used.
 */
export const PASSIVE_DCC_FAKE_HOST = '1.1.1.1';

/**
 * Split an inbound DCC CHAT line into display text plus whether it was an
 * action. Two dialects are in the wild and we accept both:
 *
 *   - mIRC style, bare `\x01ACTION waves\x01` — WeeChat (xfer-chat.c:169-179),
 *     HexChat, HexDroid and repartee emit and parse only this;
 *   - the ircII/BitchX style irssi defaults to, the same payload behind a
 *     `CTCP_MESSAGE ` (or `CTCP_REPLY `) prefix — dcc-chat.c:150-170. Nothing
 *     else understands it, so irssi flips to the bare form the moment it sees
 *     one from us (dcc-chat.c:685-687); we only ever SEND the bare form.
 *
 * A non-ACTION CTCP is unwrapped to its payload rather than dropped, matching
 * WeeChat — the alternative is showing the user control characters.
 */
export function parseDccChatLine(line: string): { text: string; action: boolean } {
  let body = line;
  for (const prefix of ['CTCP_MESSAGE ', 'CTCP_REPLY ']) {
    if (body.startsWith(prefix)) {
      body = body.slice(prefix.length);
      break;
    }
  }
  if (body.length >= 2 && body.startsWith('\u0001') && body.endsWith('\u0001')) {
    const inner = body.slice(1, -1);
    if (/^ACTION(\s|$)/i.test(inner)) {
      return { text: inner.slice(6).replace(/^\s/, ''), action: true };
    }
    return { text: inner, action: false };
  }
  return { text: body, action: false };
}

/** Human-readable byte size for status lines — 1024-based, one decimal place
 *  (whole bytes under 1 KiB). "5.0 GB", "1.5 MB", "512 B". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** One-line description of an inbound DCC SEND offer for a status buffer, e.g.
 *  `[EWG]MArchive offered "scene.mkv" (5.0 GB) via DCC SEND`. */
export function formatDccOfferLine(nick: string, offer: DccSend): string {
  const mode = offer.passive ? ' (passive)' : '';
  return `${nick} offered "${offer.filename}" (${formatBytes(offer.size)}) via DCC SEND${mode}`;
}

/**
 * Whether the cell should REFUSE to dial this DCC host. The address comes from
 * the (attacker-controlled) offer, and the cell dials it directly — so without
 * this an offer could point the cell at its own loopback, a cloud metadata
 * endpoint (169.254.169.254), or an internal VPC service (SSRF), and the
 * response would be written to a file the user can download. Blocks loopback /
 * link-local / private / CGNAT / multicast / reserved by default; the operator
 * can opt back in for LAN bots via LURKER_DCC_ALLOW_PRIVATE_HOSTS (see dccConfig).
 * `host` is the decoded form from decodeDccAddress (dotted-quad IPv4 or IPv6
 * literal).
 *
 * The range list itself lives in utils/ipGuard — link previews dial
 * user-supplied hosts too, and one drifting copy of "which addresses are
 * internal" is exactly the bug you don't find until it's exploited.
 */
export function isBlockedDccHost(host: string): boolean {
  return isBlockedIpLiteral(host);
}

// CRC32 (IEEE 802.3, the variant zip/PNG use and the one scene/anime releases
// embed in their filenames). Node's native zlib.crc32 with its incremental seed,
// so folding it over a multi-GB transfer's chunks doesn't run a byte-by-byte JS
// loop on the shared event loop.

/** Fold more bytes into a running CRC32. Seed with 0 for a fresh stream;
 *  `crc32Update(crc32Update(0, a), b)` equals the CRC32 of `a` concatenated with
 *  `b`, so it composes across chunks. */
export function crc32Update(crc: number, buf: Buffer): number {
  return zlib.crc32(buf, crc) >>> 0;
}

/** Render a CRC32 value as the conventional 8-char uppercase hex. */
export function crc32Hex(crc: number): string {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Extract the CRC32 a release filename embeds, as 8-char uppercase hex, or null
 * if absent. Scene/anime names carry it bracketed near the end, e.g.
 * `[HorribleSubs] Show - 01 [1080p][A1B2C3D4].mkv` or `(a1b2c3d4)`. The LAST
 * 8-hex bracket token wins (the CRC sits after tags like `[1080p]`).
 */
export function parseCrcFromFilename(name: string): string | null {
  // Only treat an 8-hex bracket token as the CRC when it's the LAST token,
  // optionally right before the extension (`… [1080p][A1B2C3D4].mkv`). Anchoring
  // to the end avoids mistaking a release-group or resolution tag for a CRC and
  // flagging a perfectly good file with a bogus mismatch.
  const m = /[[(]([0-9A-Fa-f]{8})[\])](?:\.[^\])]*)?$/.exec(name);
  return m ? m[1].toUpperCase() : null;
}
