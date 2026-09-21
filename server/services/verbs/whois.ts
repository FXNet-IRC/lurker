// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { dccChatPeer } from '../../../shared/channels.js';
import { registerVerb } from '../verbRegistry.js';
import { writableConnection } from './liveConn.js';
import { singleToken } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'whois',
  description:
    'Look up a nick on a network (sends WHOIS). The reply is asynchronous — it lands as numeric ' +
    'lines in the network\'s server buffer, whose target is the literal ":server:<networkId>" ' +
    '(e.g. ":server:3" for network 3). That buffer is not listed by list_buffers, so read the ' +
    'result by passing that exact target to recent_messages. The returned `serverBuffer` field ' +
    'carries the string ready to use. Returns { ok: false, error: "not-connected" } when the ' +
    'network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = singleToken(input.nick, {
      empty: 'empty-nick',
      malformed: 'nick-must-be-single-token',
    });
    if ('error' in nick) return { ok: false, error: nick.error };
    // ⚠ A `=bob` DCC chat means bob. This goes out as a RAW line, which bypasses
    // every `=` guard in ircManager, so an agent handing us a buffer target put
    // `WHOIS =bob` on the wire. The web client's whois store normalizes the same
    // way; this is the door it doesn't cover. A bare `=` names nobody.
    const who = dccChatPeer(nick.value);
    if (!who) return { ok: false, error: 'empty-nick' };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`WHOIS ${who}`);
    // Hand back the concrete buffer target rather than describing it. The
    // server buffer is deliberately filtered out of list_buffers, so an agent
    // told only "read the server buffer" has no way to name it.
    return {
      ok: true,
      serverBuffer: conn.serverTarget(),
      note: 'result arrives asynchronously; read it with recent_messages on `serverBuffer`',
    };
  },
});
