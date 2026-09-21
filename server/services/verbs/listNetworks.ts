// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { listNetworksForUser } from '../../db/networks.js';
import ircManager from '../ircManager.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'list_networks',
  description:
    'List the IRC networks configured for the caller, with live connection state and current nick.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler(ctx: VerbContext, _input: Record<string, unknown>) {
    return listNetworksForUser(ctx.userId).map((net) => {
      const conn = ircManager.getConnection(ctx.userId, net.id);
      return {
        id: net.id,
        name: net.name,
        connected: conn?.state === 'connected',
        // ⚠ currentNick, not the framework's copy. irc-framework won't store a
        // digit-leading nick (client.js:266), so after a netsplit collision
        // SAVEs us to our UID its user.nick still names our OLD nick — which is
        // now free, and if a stranger takes it and renames, the framework
        // writes THEIR new nick into our copy. currentNick follows us through.
        nick: conn?.currentNick || net.nick,
      };
    });
  },
});
