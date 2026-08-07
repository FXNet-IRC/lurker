// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { useIgnoresStore } from '../stores/ignores.js';
import { isChannelTarget } from '../../../shared/channels.js';

export interface PrimableEvent {
  type?: string;
  text?: string | null;
  nick?: string;
  userhost?: string | null;
  networkId?: number | string | null;
  target?: string | null;
}

/**
 * The message bodies in a batch of events that could actually produce a rendered attachment.
 *
 * Its own module, and not inlined in the socket layer, because it is pure policy about what the
 * server is allowed to be asked to fetch — and because nothing in the socket layer is reachable
 * from a test.
 *
 * Two filters, and both of them stop the SERVER making an outbound request on behalf of
 * something nobody will ever see:
 *
 * ⚠ **Type.** `MessageList` mounts `MessageAttachments` for `message` and `action` only, but
 * priming ran over every event in the frame — and part/quit publish their reason as `text`,
 * topic publishes the topic, and a history page ships the whole contiguous range with the noise
 * included. So joining a channel whose topic is a URL, or scrolling past
 * `Quit: HexChat https://hexchat.github.io`, made the server fetch a page no render path can
 * display. The live path already filtered this way and the backlog path did not; the two
 * disagreeing is what hid it.
 *
 * ⚠ **Ignores.** Ignoring is client-side and render-time — the server ships the event intact and
 * `MessageList` drops it while building rows — so priming, which runs BEFORE any of that,
 * happily fetched every link posted by someone the user has explicitly silenced. Ignoring
 * somebody is a veto on the fetch too, not just on the row.
 */
export function previewableEventTexts(
  events: unknown,
  fallbackNetworkId?: number | string | null,
  fallbackTarget?: string | null,
): (string | null | undefined)[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const ignores = useIgnoresStore();
  const out: (string | null | undefined)[] = [];
  for (const raw of events) {
    const e = raw as PrimableEvent | null;
    if (!e || (e.type !== 'message' && e.type !== 'action')) continue;
    if (!e.text) continue;
    // A frame carries its network and target once; a live event carries its own.
    const networkId = e.networkId ?? fallbackNetworkId;
    const target = e.target ?? fallbackTarget ?? '';
    if (networkId != null && target) {
      const verdict = ignores.evaluate(networkId, {
        nick: e.nick ?? '',
        userhost: e.userhost ?? null,
        target,
        text: e.text,
        type: e.type,
        // The same derivation MessageList uses; a store lookup would need the buffer.
        isDm: !isChannelTarget(target) && !target.startsWith(':server:'),
      });
      if (verdict.hide) continue;
    }
    out.push(e.text);
  }
  return out;
}
