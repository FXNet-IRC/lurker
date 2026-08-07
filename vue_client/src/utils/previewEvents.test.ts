// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { previewableEventTexts } from './previewEvents.js';
import { useIgnoresStore } from '../stores/ignores.js';

const LINK = 'https://e.test/thing';

function event(over: Record<string, unknown>) {
  return { type: 'message', nick: 'alice', userhost: 'alice@host', text: `see ${LINK}`, ...over };
}

beforeEach(() => setActivePinia(createPinia()));

describe('previewableEventTexts — only what can render', () => {
  it('passes messages and actions through', () => {
    const got = previewableEventTexts([event({}), event({ type: 'action' })], 1, '#chan');
    expect(got).toHaveLength(2);
  });

  it('drops every event type that has no attachment renderer', () => {
    // ⚠ These all carry a `text`, which is exactly why mapping over it was wrong: part and quit
    // publish their REASON there, and topic publishes the topic. Joining a channel whose topic
    // is a URL, or scrolling past `Quit: HexChat https://hexchat.github.io`, made the server
    // perform a real outbound fetch for a row that can never show an attachment — burning the
    // per-account resolve budget and the client's cache ceiling on unrenderable content.
    const noise = ['quit', 'part', 'join', 'topic', 'notice', 'motd', 'nick', 'kick'].map((type) =>
      event({ type }),
    );
    expect(previewableEventTexts(noise, 1, '#chan')).toEqual([]);
  });

  it('tolerates junk in the array', () => {
    expect(previewableEventTexts([null, undefined, {}, event({ text: '' })], 1, '#chan')).toEqual(
      [],
    );
    expect(previewableEventTexts(null, 1, '#chan')).toEqual([]);
  });
});

describe('previewableEventTexts — ignoring is a veto on the FETCH', () => {
  function ignore(mask: string) {
    useIgnoresStore().byNetwork[1] = [
      {
        id: 1,
        createdAt: '2026-01-01T00:00:00Z',
        mask,
        channels: null,
        pattern: null,
        patternKind: 'substr',
        // `levels: []` compiles to a rule that hides nothing — a bare `/ignore mask` carries ALL.
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
  }

  it('does not ask about a link from an ignored sender', () => {
    // ⚠⚠ Ignores are client-side and render-time — the server ships the event intact and
    // MessageList drops it while building rows. Priming runs BEFORE all of that, so a user who
    // has `/ignore spammer` was still causing their own server to fetch every link that spammer
    // posted, for rows they had explicitly chosen never to see.
    ignore('spammer!*@*');
    const events = [event({ nick: 'spammer', userhost: 'spammer@bad.host' }), event({})];
    expect(previewableEventTexts(events, 1, '#chan')).toEqual([`see ${LINK}`]);
  });

  it('leaves everyone else alone', () => {
    ignore('someoneelse!*@*');
    expect(previewableEventTexts([event({})], 1, '#chan')).toHaveLength(1);
  });

  it('uses the FRAME network and target when the event carries none', () => {
    // A backlog frame names its network and target once, at the top; only live events repeat
    // them. Without the fallback the ignore check was skipped for every history page.
    ignore('spammer!*@*');
    const fromBacklog = {
      type: 'message',
      nick: 'spammer',
      userhost: 'spammer@bad.host',
      text: 'x',
    };
    expect(previewableEventTexts([fromBacklog], 1, '#chan')).toEqual([]);
    // ...and with no network to evaluate against, it can only let it through.
    expect(previewableEventTexts([fromBacklog], null, null)).toEqual(['x']);
  });
});
