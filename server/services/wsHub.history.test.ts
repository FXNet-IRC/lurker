// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `countBy:'renderable'` end to end, over a real socket (WS_PROTOCOL_FIXES #10).
//
// messages.test.ts proves the paging primitive. It cannot prove the thing that
// actually broke for the user, which is the WIRING: each `history` mode reaches
// the primitive by a different route — `latest` and `after` call it directly,
// `before` goes through the `recent_messages` verb, whose input schema is
// `additionalProperties:false` and would reject an undeclared field. A
// function-level test passes with any one of those three wired up wrong.
//
// So: a real client, a real socket, one request per mode, against a channel
// shaped like the one that motivated the feature — twenty messages buried under
// a netsplit's worth of joins.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-history');

const CHANNEL = '#noisy';
// Per real message. Comfortably more than any `limit` used below, so an
// event-counted page of that limit can only ever hold ONE message.
const NOISE_PER_MESSAGE = 30;
const MESSAGE_COUNT = 20;

let server: http.Server;
let userId: number;
let networkId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let url: string;
/** Ids of the real messages, oldest first. */
const messageIds: number[] = [];

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');
  // `history` mode 'before' delegates to the `recent_messages` verb, and the
  // registry is populated by import side effect (server.ts does this at boot).
  // Without it that one mode answers `error: history fetch failed`.
  await import('./verbs/index.js');

  userId = createUser('historyuser').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'historyuser',
  });
  networkId = net!.id;
  buffers.ensureExists(userId, networkId, CHANNEL);

  const put = (type: string, nick: string, text?: string): number =>
    Number(
      insertMessage({
        networkId,
        target: CHANNEL,
        time: new Date().toISOString(),
        type,
        nick,
        text: text ?? null,
        self: false,
      }).id,
    );
  for (let i = 1; i <= MESSAGE_COUNT; i += 1) {
    for (let j = 0; j < NOISE_PER_MESSAGE; j += 1) put('join', `lurker${j}`);
    messageIds.push(put('message', 'alice', `m${i}`));
  }

  server = http.createServer();
  attachWsHub(server, 'history-test-secret');
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

type Frame = Record<string, unknown>;
interface HistoryReply extends Frame {
  kind: 'history';
  events: Array<{ id: number; type: string; text: string | null }>;
  hasMoreOlder?: boolean;
  hasMoreNewer?: boolean;
}

/**
 * Connect, let the burst drain, send one `history` request and hand back its
 * reply. Waiting for `backlog-complete` first is what keeps the connect frames
 * from being mistaken for the answer.
 */
function requestHistory(request: Frame): Promise<HistoryReply> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(userId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const seen: string[] = [];
    let sent = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no history reply; got: ${seen.join(', ')}`));
    }, 3000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      seen.push(String(frame.kind));
      if (frame.kind === 'backlog-complete' && !sent) {
        sent = true;
        ws.send(JSON.stringify(request));
        return;
      }
      // Surface a refused request as itself rather than as a timeout — the
      // reason is in the frame, and waiting three seconds to say "no reply"
      // throws it away.
      if (frame.kind === 'error' && sent) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`server refused the request: ${String(frame.text)}`));
        return;
      }
      if (frame.kind !== 'history') return;
      clearTimeout(timer);
      ws.close();
      resolve(frame as HistoryReply);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const realMessages = (reply: HistoryReply): string[] =>
  reply.events.filter((e) => e.type === 'message').map((e) => e.text as string);

describe("history countBy:'renderable' (#10)", () => {
  it('fills a `latest` page with messages instead of presence churn', async () => {
    const base = { type: 'history', mode: 'latest', networkId, target: CHANNEL, limit: 5 };

    // Today's behavior, unchanged: five rows, four of them noise.
    const eventCounted = await requestHistory(base);
    expect(eventCounted.events).toHaveLength(5);
    expect(realMessages(eventCounted)).toEqual(['m20']);

    // The hydrate a client actually wants: five real messages, with their runs
    // along for the ride so consolidation can still summarize them.
    const renderable = await requestHistory({ ...base, countBy: 'renderable' });
    expect(realMessages(renderable)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20']);
    expect(renderable.events.length).toBeGreaterThan(5);
    // More history behind it, so the upward pager stays armed.
    expect(renderable.hasMoreOlder).toBe(true);
  });

  it('honors countBy on `before` — the page that goes through the verb', async () => {
    const reply = await requestHistory({
      type: 'history',
      networkId,
      target: CHANNEL,
      before: messageIds[10],
      limit: 4,
      countBy: 'renderable',
    });
    expect(realMessages(reply)).toEqual(['m7', 'm8', 'm9', 'm10']);
    expect(reply.events.every((e) => e.id < messageIds[10])).toBe(true);
    expect(reply.hasMoreOlder).toBe(true);
  });

  it('honors countBy on `after`', async () => {
    const reply = await requestHistory({
      type: 'history',
      mode: 'after',
      networkId,
      target: CHANNEL,
      afterId: messageIds[2],
      limit: 3,
      countBy: 'renderable',
    });
    expect(realMessages(reply)).toEqual(['m4', 'm5', 'm6']);
    expect(reply.events.every((e) => e.id > messageIds[2])).toBe(true);
    expect(reply.hasMoreNewer).toBe(true);
  });

  it('ships a contiguous id range, so paging can never open a hole', async () => {
    // The property the whole design rests on: a renderable-counted page is the
    // same shape as an event-counted one — a gapless run — so `before: <oldest
    // returned id>` keeps working and a client that prepends-and-dedupes ends up
    // with an unbroken buffer.
    const page1 = await requestHistory({
      type: 'history',
      mode: 'latest',
      networkId,
      target: CHANNEL,
      limit: 3,
      countBy: 'renderable',
    });
    const page2 = await requestHistory({
      type: 'history',
      networkId,
      target: CHANNEL,
      before: page1.events[0].id,
      limit: 3,
      countBy: 'renderable',
    });
    const ids = [...page2.events, ...page1.events].map((e) => e.id);
    expect(ids).toEqual([...ids].toSorted((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length); // no overlap between the pages
    // Gapless: the two pages joined cover every id in their span. Message ids
    // are a global sequence, but this buffer's rows were seeded contiguously.
    expect(ids.at(-1)! - ids[0] + 1).toBe(ids.length);
    expect(realMessages(page2)).toEqual(['m15', 'm16', 'm17']);
  });

  it('ignores an unknown countBy rather than erroring', async () => {
    // Additive field, forward-compatible in both directions: a value this server
    // doesn't know degrades to today's page instead of failing the request.
    const reply = await requestHistory({
      type: 'history',
      mode: 'latest',
      networkId,
      target: CHANNEL,
      limit: 5,
      countBy: 'sausages',
    });
    expect(reply.kind).toBe('history');
    expect(reply.events).toHaveLength(5);
  });
});
