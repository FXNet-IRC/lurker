// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { channelArg } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'get_topic',
  description:
    "Read a joined channel's current topic from the live connection. Returns { ok: true, topic } " +
    '(topic is null when unset), or "not-in-channel" if you are not in it / "not-connected" when ' +
    'the network is offline.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    // Fold-aware (#707): a raw channels-map probe reports not-in-channel for a
    // fold-variant spelling of a channel we're actually in.
    const ch = conn.channelState(channel.value);
    if (!ch) return { ok: false, error: 'not-in-channel' };
    return { ok: true, channel: ch.name, topic: ch.topic ?? null };
  },
});
