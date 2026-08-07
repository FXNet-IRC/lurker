// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { listNetworksForUser } from '../../db/networks.js';
import { listBuffersForNetwork } from '../../db/messages.js';
import { isChannelTarget } from '../../../shared/channels.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

function bufferKind(target: string): 'channel' | 'dm' {
  if (isChannelTarget(target)) return 'channel';
  return 'dm';
}

registerVerb({
  name: 'list_buffers',
  description:
    "List the caller's open buffers (channels and DMs) across one or all networks, with the most recent message timestamp.",
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: {
        type: 'integer',
        description:
          'Optional. Restrict the listing to a single network. If omitted, returns buffers across every network the caller owns.',
      },
    },
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    // Network ownership for the filtered case is enforced by the registry
    // boundary; we just walk the caller's networks here.
    const networks = listNetworksForUser(ctx.userId);
    const filterId = input.networkId != null ? Number(input.networkId) : null;
    const out: Array<{ networkId: number; target: string; kind: string; lastMessageAt: unknown }> =
      [];
    for (const net of networks) {
      if (filterId !== null && net.id !== filterId) continue;
      for (const row of listBuffersForNetwork(net.id) as Array<{
        target: string;
        lastMessageAt: unknown;
      }>) {
        out.push({
          networkId: net.id,
          target: row.target,
          kind: bufferKind(row.target),
          lastMessageAt: row.lastMessageAt,
        });
      }
    }
    return out;
  },
});
