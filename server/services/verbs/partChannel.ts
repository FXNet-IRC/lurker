// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { channelArg, singleLine } from './args.js';
import { writableConnection } from './liveConn.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'part_channel',
  description:
    'Leave a channel on a network, with an optional part reason. The buffer stays in your list ' +
    '(dimmed) unless you also close it. Returns { ok: false, error: "not-connected" } when the ' +
    'network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      reason: { type: 'string', description: 'Optional part message.' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    // Same unstripped path as join's key: client.part() writes verbatim.
    const parsed = singleLine(input.reason, { malformed: 'reason-must-be-single-line' });
    if ('error' in parsed) return { ok: false, error: parsed.error };
    if (!writableConnection(ctx.userId, networkId)) return { ok: false, error: 'not-connected' };
    const ok = ircManager.partChannel(ctx.userId, networkId, channel.value, parsed.value);
    return ok ? { ok: true } : { ok: false, error: 'not-connected' };
  },
});
