// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { writableConnection } from './liveConn.js';
import { channelArg } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_topic',
  description:
    "Set a channel's topic. `topic` is REQUIRED, and an empty string CLEARS the topic — this " +
    'verb always writes, so read the current topic with get_topic rather than calling this with ' +
    'a blank. Requires the appropriate channel privileges (usually +o or a -t channel); the ' +
    'server may reject it — watch the channel/server buffer. Returns { ok: false, error: ' +
    '"not-connected" } when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      channel: { type: 'string', description: 'Channel name, e.g. "#foo".' },
      topic: {
        type: 'string',
        description: 'The new topic. An empty string clears the channel topic.',
      },
    },
    // `topic` is required on purpose. It used to be optional and defaulted to
    // '', which sent `TOPIC #chan :` — the IRC *clear* — so an agent that
    // simply forgot the argument silently wiped a channel topic. Requiring it
    // makes clearing an explicit `topic: ""`. (The web client's /topic resolves
    // the same ambiguity the other way: no body sends a parameterless `TOPIC
    // #chan`, which QUERIES. Here that job belongs to get_topic.)
    required: ['networkId', 'channel', 'topic'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const channel = channelArg(input.channel);
    if ('error' in channel) return { ok: false, error: channel.error };
    if (typeof input.topic !== 'string') return { ok: false, error: 'topic-must-be-a-string' };
    const topic = input.topic;
    if (/[\r\n]/.test(topic)) return { ok: false, error: 'topic-must-be-single-line' };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`TOPIC ${channel.value} :${topic}`);
    return { ok: true };
  },
});
