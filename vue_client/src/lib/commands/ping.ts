// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Who a bare `/ping` means in the buffer it was typed in. Pure so it unit-tests
// outside the Vue SFC, like the other command helpers.

import { dccChatPeer, isChannelTarget } from '../../../../shared/channels.js';

/**
 * The person a buffer is a conversation with, or '' when it isn't one: a DM's
 * peer, and a `=nick` DCC chat's too. A channel (all four sigils) and the
 * `:server:` / `:system:` pseudo-buffers name nobody.
 *
 * ⚠⚠ A DCC chat answers with its PEER, never the buffer name. `/ping` goes out
 * as a CTCP on the IRC wire, so defaulting to `=bob` sent `PRIVMSG =bob :…`
 * (#270). A bare `=` has no peer and answers ''.
 */
export function bufferPeer(target: string | null | undefined): string {
  if (!target || isChannelTarget(target) || target.startsWith(':')) return '';
  return dccChatPeer(target);
}
