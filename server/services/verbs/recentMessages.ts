// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { listMessagesCounted, hasOlderRow } from '../../db/messages.js';
import { asPageUnit } from '../../../shared/eventFilter.js';
import { decorateMessage, bufferNotifyAlways } from '../wsHub.js';

/** Authenticated caller context passed to every verb handler. */
interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'recent_messages',
  description:
    'Fetch a window of recent messages for one buffer, oldest-first. Paginate backwards by passing the lowest id from a previous result as `before`.',
  scope: 'read',
  input: {
    type: 'object',
    properties: {
      networkId: {
        type: 'integer',
        description: 'The network id (from list_networks).',
      },
      target: {
        type: 'string',
        description: 'The buffer target — a channel name like "#foo" or a peer nick for a DM.',
      },
      limit: {
        type: 'integer',
        description: 'How many messages to return. Default 100, max 500.',
        minimum: 1,
        maximum: 500,
      },
      before: {
        type: 'integer',
        description: 'Optional. Return only messages with id < before, for backward pagination.',
      },
      countBy: {
        type: 'string',
        enum: ['event', 'renderable', 'chat'],
        description:
          'What `limit` counts. "event" (default) counts every stored row. "renderable" counts ' +
          'only rows that render as their own line — join/part/quit/nick/host-change events are ' +
          'still returned, but do not spend the budget, so a channel full of presence churn ' +
          'still yields a full page of readable content. "chat" goes one further and also ' +
          'excludes mode changes from the budget, matching a reader who hides event noise ' +
          'entirely. All three return the same contiguous id range; only the sizing differs.',
      },
    },
    required: ['networkId', 'target'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const target = typeof input.target === 'string' ? input.target.trim() : '';
    if (!target) {
      throw Object.assign(new Error('target is empty or whitespace'), { code: 'invalid_input' });
    }
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
    const before = input.before ? Number(input.before) : undefined;
    // Unrecognized values fall back to today's behavior rather than erroring —
    // the field is additive and an old caller never sends it at all.
    const rows = listMessagesCounted(networkId, target, asPageUnit(input.countBy), {
      before,
      limit,
    });
    // One buffer per call, so the notify-always answer is constant across the
    // page — hoist it out of the map (#679).
    const notifyAlways = bufferNotifyAlways(ctx.userId, networkId, target);
    const events = rows.map((e) => decorateMessage(ctx.userId, e, notifyAlways));
    const oldestId = events.length ? events[0].id : 0;
    return {
      messages: events,
      hasOlder: oldestId > 0 && hasOlderRow(networkId, target, oldestId),
    };
  },
});
