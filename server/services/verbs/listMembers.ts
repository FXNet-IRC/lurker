// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { channelArg } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

registerVerb({
  name: 'list_members',
  description:
    'List the members currently in a channel on a network, with their prefix modes (o=op, ' +
    'h=halfop, v=voice, …) and away state. Live membership from the active connection — the ' +
    'channel must be joined. Sorted by nick and capped at `limit` (default 200, max 1000): ' +
    '`count` is always the true membership total, and `truncated` says whether the returned ' +
    'page is short of it. Returns { ok: false, error: "not-in-channel" } if you are not in it, ' +
    'or "not-connected" when the network is offline.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      limit: {
        type: 'integer',
        description: 'How many members to return. Default 200, max 1000.',
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ['networkId', 'channel'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    // Fold-aware (#707): see get_topic.
    const ch = conn.channelState(channel.value);
    if (!ch) return { ok: false, error: 'not-in-channel' };
    const members = [...ch.members.values()].map((m) => ({
      nick: m.nick,
      modes: m.modes,
      away: m.away,
    }));
    members.sort((a, b) => a.nick.localeCompare(b.nick));
    // A 5k-nick channel is a real thing and this answer goes straight into a
    // model's context, so the page is capped the way recent_messages caps its
    // window. `count` stays the true total — truncating it too would make the
    // cap invisible, which is the one thing a caller must be able to see.
    const page = members.slice(0, limit);
    return {
      ok: true,
      channel: ch.name,
      count: members.length,
      truncated: page.length < members.length,
      members: page,
    };
  },
});
