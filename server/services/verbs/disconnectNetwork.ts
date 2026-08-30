// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';
import { singleLine } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'disconnect_network',
  description:
    'Disconnect a network (sends QUIT with the optional `reason` and tears down the connection). ' +
    'The network stays configured — reconnect later with connect_network. Always returns ' +
    '{ ok: true }; disconnecting an already-offline network is a no-op.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      reason: { type: 'string', description: 'Optional QUIT message.' },
    },
    required: ['networkId'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    // Reaches irc-framework's client.quit(), which writes the line verbatim.
    const parsed = singleLine(input.reason, { malformed: 'reason-must-be-single-line' });
    if ('error' in parsed) return { ok: false, error: parsed.error };
    ircManager.stopNetwork(ctx.userId, networkId, parsed.value);
    return { ok: true };
  },
});
