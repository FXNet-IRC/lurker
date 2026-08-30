// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Mode-change classification, and the "is this row churn?" question the event
// filters ask of it.
//
// A single IRC MODE message carries a list of changes, and the three classes
// behave nothing alike:
//
//   +o alice          a MEMBER's status changed — the op/voice churn that
//                     motivates every filter in this file
//   +b *!*@host       a LIST mode: a mask was added to the ban/exception/quiet
//                     list. Consequential, and never churn.
//   +m / +k / +l 50   a CHANNEL flag or parameter mode. Also not churn.
//
// Telling them apart requires the server's ISUPPORT PREFIX and CHANMODES
// tokens, which the browser has never seen and has no business parsing — so
// the SERVER classifies each change at publish time and stamps `kind` onto it
// (see classifyModeChange). The stamp rides `extra.modes` into storage, so a
// backlog row answers the question the same way a live one does.
//
// ⚠ Do NOT reintroduce a hardcoded q/a/o/h/v set on either side. It was tried
// and it disagreed with solanum, where `+q` is a quiet LIST mode rather than an
// owner prefix — see the comment on IrcConnection.prefixModes().

/** Which of the three worlds a single mode change belongs to. */
export type ModeChangeKind = 'prefix' | 'list' | 'chan';

/** One entry of a MODE message's change list, as stored and sent to clients. */
export interface ModeChange {
  /** The signed token, e.g. `+o` or `-b`. */
  mode: string;
  /** The argument, when the mode takes one: a nick, a mask, a key, a limit. */
  param?: string;
  /**
   * The class, stamped by the server. Absent on rows written before the stamp
   * existed — treat missing as "not prefix", which is the fail-visible
   * direction: an unclassified row shows and never folds.
   */
  kind?: ModeChangeKind;
}

/** The letter of a signed mode token, i.e. `+o` → `o`. */
export function modeLetter(mode: string): string {
  return mode.startsWith('+') || mode.startsWith('-') ? mode.slice(1) : mode;
}

/**
 * Classify one change against a server's ISUPPORT sets. Server-side only — the
 * clients read the stamped `kind` instead.
 *
 * ⚠ The precedence here is load-bearing and must stay identical to the branch
 * order in IrcConnection's `mode` handler, which applies the same test to
 * decide whether a change lands on the member map or on the channel. If the two
 * ever disagree, a row is filtered as one thing and applied as another. They
 * share this function precisely so they can't.
 *
 *   1. a change WITH a param whose letter is a member prefix → `prefix`
 *   2. otherwise, a letter in CHANMODES group A → `list`
 *   3. otherwise → `chan`
 *
 * Note step 1's param requirement: a bare `+o` with no argument is malformed,
 * and falls through to be tracked as a channel flag — which is what the handler
 * has always done with it.
 */
export function classifyModeChange(
  change: ModeChange,
  prefixModes: ReadonlySet<string>,
  listModes: ReadonlySet<string>,
): ModeChangeKind {
  const letter = modeLetter(change.mode);
  if (change.param && prefixModes.has(letter)) return 'prefix';
  if (listModes.has(letter)) return 'list';
  return 'chan';
}

/**
 * Whether a MODE row is presence churn — the single predicate the smart filter
 * and (later) consolidation both ask.
 *
 * True only when the message carries at least one change and EVERY change in it
 * grants or revokes member status. One ban, key, or channel flag anywhere in the
 * message makes the whole row non-churn.
 *
 * That whole-message gate is deliberate, and matches weechat (`irc-mode.c`,
 * where `smart_filter` is cleared the moment any ineligible letter appears).
 * We render one row per MODE message and have no way to draw half of one, so a
 * mixed `+o-b alice *!*@host` has to be all-or-nothing — and showing it is the
 * direction that can't silently swallow a ban.
 */
export function isChurnMode(modes: readonly ModeChange[] | null | undefined): boolean {
  if (!modes || modes.length === 0) return false;
  // `kind === 'prefix'` already implies a param on anything the server stamped;
  // the explicit param test also covers a hand-built or hand-edited row.
  return modes.every((m) => !!m && m.kind === 'prefix' && !!m.param);
}

/**
 * The nicks a MODE message acted ON — the params of its member-status changes.
 *
 * These, not the message's author, are the subject the smart filter judges. The
 * author of a mode line is usually ChanServ or an op bot that never speaks in
 * the channel, so keying on it would hide essentially every mode change. weechat
 * keys on the target too (`irc-mode.c`, the nick-speaking-time check sits in the
 * per-nick mode branch); halloy keys on the author, and that looks like a bug.
 */
export function modeTargets(modes: readonly ModeChange[] | null | undefined): string[] {
  if (!modes) return [];
  const out: string[] = [];
  for (const m of modes) {
    if (m && m.kind === 'prefix' && m.param) out.push(m.param);
  }
  return out;
}

/**
 * Whether the smart rung hides this MODE row.
 *
 * Shown — never hidden — when any of these hold:
 *
 *   - the message isn't pure member-status churn (see isChurnMode);
 *   - we sent it;
 *   - it acted on us;
 *   - any nick it acted on has spoken recently.
 *
 * The last two are why this takes a callback rather than a speaker map: "spoke
 * recently" is a window ending at the event's own timestamp, and each client
 * already owns that comparison. The rest of the decision is identical
 * everywhere, so it lives here rather than being written twice.
 *
 * ⚠ Known trade-off, inherited from weechat's default and not yet decided
 * against: in a moderated (+m) channel, `+v alice` is the permission for alice
 * to START speaking, so "has the target spoken recently" is guaranteed false and
 * the grant is always hidden — in exactly the channels where voice grants carry
 * the most meaning. The candidate remedy is to extend the join-unmask idea to
 * mode grants (reveal the row when the target speaks shortly AFTER it), which
 * this signature has room for. Left alone for now rather than diverging from the
 * reference on a guess.
 *
 * @param actorNick who sent the MODE. Used only to spot our own.
 * @param ownNickLc our nick on this network, lowercased; null when unknown.
 * @param spokeRecently whether a nick spoke inside the window ending at this event.
 */
export function smartHidesMode(
  modes: readonly ModeChange[] | null | undefined,
  actorNick: string | null | undefined,
  ownNickLc: string | null,
  spokeRecently: (nick: string) => boolean,
): boolean {
  if (!isChurnMode(modes)) return false;
  if (ownNickLc && actorNick && actorNick.toLowerCase() === ownNickLc) return false;
  const targets = modeTargets(modes);
  if (ownNickLc && targets.some((t) => t.toLowerCase() === ownNickLc)) return false;
  // Any one recent speaker shows the whole row, matching the whole-message gate
  // above rather than hiding a `+ooo a b c` because two of the three were
  // strangers.
  return !targets.some((t) => spokeRecently(t));
}
