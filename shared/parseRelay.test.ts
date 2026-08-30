// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  parseRelayMessage,
  parseRelayChain,
  compileRelayTemplate,
  DEFAULT_RELAY_TEMPLATES,
} from './parseRelay.js';

describe('parseRelayMessage — default formats', () => {
  it('parses the bracketed-source form `[source] <nick> message`', () => {
    expect(parseRelayMessage('[Discord] <alice> hello there')).toEqual({
      source: 'Discord',
      nick: 'alice',
      text: 'hello there',
    });
  });

  it('parses the bare `<nick> message` form (no source tag)', () => {
    expect(parseRelayMessage('<bob> hey everyone')).toEqual({
      source: null,
      nick: 'bob',
      text: 'hey everyone',
    });
  });

  it('keeps angle brackets and brackets that appear inside the message body', () => {
    expect(parseRelayMessage('[Telegram] <carol> 2 < 3 and [maybe] > nope')).toEqual({
      source: 'Telegram',
      nick: 'carol',
      text: '2 < 3 and [maybe] > nope',
    });
  });

  it('preserves an empty relayed message', () => {
    expect(parseRelayMessage('[IRC] <dave> ')).toEqual({ source: 'IRC', nick: 'dave', text: '' });
  });

  it('does not match a plain message with no envelope', () => {
    expect(parseRelayMessage('just a normal line from the bot')).toBeNull();
  });

  it('does not match when only a closing bracket is present', () => {
    expect(parseRelayMessage('lunch < later')).toBeNull();
  });

  it('returns null for empty / nullish bodies', () => {
    expect(parseRelayMessage('')).toBeNull();
    expect(parseRelayMessage(null)).toBeNull();
    expect(parseRelayMessage(undefined)).toBeNull();
  });

  it('handles a source tag that contains spaces', () => {
    expect(parseRelayMessage('[Game Chat] <eve> gg')).toEqual({
      source: 'Game Chat',
      nick: 'eve',
      text: 'gg',
    });
  });
});

describe('parseRelayMessage — membership prefixes', () => {
  it('drops a leading +voice prefix from the nick', () => {
    expect(parseRelayMessage('<+bob> hi')).toEqual({ source: null, nick: 'bob', text: 'hi' });
  });

  it('drops stacked prefixes (e.g. @+) but keeps the rest of the nick', () => {
    expect(parseRelayMessage('[net] <@+carol> yo')).toEqual({
      source: 'net',
      nick: 'carol',
      text: 'yo',
    });
  });

  it('leaves a normal nick untouched', () => {
    expect(parseRelayMessage('<dave> hey')).toEqual({ source: null, nick: 'dave', text: 'hey' });
  });
});

describe('parseRelayMessage — custom templates', () => {
  it('honors a custom `nick: message` template', () => {
    expect(parseRelayMessage('frank: yo', '{nick}: {message}')).toEqual({
      source: null,
      nick: 'frank',
      text: 'yo',
    });
  });

  it('honors a custom template with a parenthesized source', () => {
    expect(parseRelayMessage('(Matrix) grace » hi', '({source}) {nick} » {message}')).toEqual({
      source: 'Matrix',
      nick: 'grace',
      text: 'hi',
    });
  });

  it('falls back to defaults when the custom pattern is blank', () => {
    expect(parseRelayMessage('[Slack] <heidi> ok', '   ')).toEqual({
      source: 'Slack',
      nick: 'heidi',
      text: 'ok',
    });
  });

  it('returns null when the custom template lacks required placeholders', () => {
    expect(parseRelayMessage('whatever', 'no placeholders here')).toBeNull();
    expect(parseRelayMessage('<x> y', '<{nick}> no-message-placeholder')).toBeNull();
  });
});

describe('parseRelayMessage — reversed layout (nick before source)', () => {
  // Real ##videogames bot that posts `<nick> [source] message` — the reverse of
  // our default — plus a stray colour code and fancy unicode/emoji in the body.
  const raw = '\x0303<EyeSeeYou> [Discord] Present: 𝔅𝔢𝔩𝔦𝔞𝔩 ChatGAYTB 🌈🏳️‍🌈 syrius';

  it('extracts source/nick/message cleanly with a matching custom template', () => {
    expect(parseRelayMessage(raw, '<{nick}> [{source}] {message}')).toEqual({
      source: 'Discord',
      nick: 'EyeSeeYou',
      text: 'Present: 𝔅𝔢𝔩𝔦𝔞𝔩 ChatGAYTB 🌈🏳️‍🌈 syrius',
    });
  });

  it('with defaults, still attributes the nick but leaves [source] inline', () => {
    // The bare `<nick> message` default catches it, so re-attribution works, but
    // the reversed [source] tag isn't recognized — it stays in the body. This is
    // the behavior that motivates the custom template above.
    expect(parseRelayMessage(raw)).toEqual({
      source: null,
      nick: 'EyeSeeYou',
      text: '[Discord] Present: 𝔅𝔢𝔩𝔦𝔞𝔩 ChatGAYTB 🌈🏳️‍🌈 syrius',
    });
  });
});

describe('parseRelayMessage — mIRC formatting', () => {
  it('strips colour codes AND the +voice prefix off the nick (the ##videogames case)', () => {
    // Bot colours the nick `+FAST` (voiced on efnet) with mIRC colour 13, resets
    // before `>`. We want a clean `FAST` so coloring/Reply/Copy target the nick.
    const raw = '[efnet] <\x0313+FAST\x03> ultros: bet';
    expect(parseRelayMessage(raw)).toEqual({
      source: 'efnet',
      nick: 'FAST',
      text: 'ultros: bet',
    });
  });

  it('strips colour codes wrapping the source tag too', () => {
    const raw = '\x0304[efnet]\x03 <\x0313FAST\x03> hey there';
    expect(parseRelayMessage(raw)).toEqual({ source: 'efnet', nick: 'FAST', text: 'hey there' });
  });

  it('strips bold/underline toggles around the envelope', () => {
    const raw = '[\x02Discord\x02] <\x1funderlined\x1f> hello';
    expect(parseRelayMessage(raw)).toEqual({
      source: 'Discord',
      nick: 'underlined',
      text: 'hello',
    });
  });

  it("preserves the message's OWN formatting in the displayed text", () => {
    // Nick is coloured (stripped for matching), but the message is bold and that
    // bold survives into the re-attributed line.
    const raw = '[efnet] <\x0313FAST\x03> \x02bold msg\x02';
    expect(parseRelayMessage(raw)).toEqual({
      source: 'efnet',
      nick: 'FAST',
      text: '\x02bold msg\x02',
    });
  });

  it('preserves message colour codes after the envelope', () => {
    const raw = '<\x0307relaybot\x03> \x0304red\x03 and \x0309green\x03';
    expect(parseRelayMessage(raw)).toEqual({
      source: null,
      nick: 'relaybot',
      text: '\x0304red\x03 and \x0309green\x03',
    });
  });
});

describe('compileRelayTemplate', () => {
  it('compiles the built-in defaults', () => {
    for (const t of DEFAULT_RELAY_TEMPLATES) {
      expect(compileRelayTemplate(t)).not.toBeNull();
    }
  });

  it('records slot order for source/nick/message', () => {
    const compiled = compileRelayTemplate('[{source}] <{nick}> {message}');
    expect(compiled?.slots).toEqual(['source', 'nick', 'message']);
  });

  it('rejects a template missing {nick} or {message}', () => {
    expect(compileRelayTemplate('<{nick}> static')).toBeNull();
    expect(compileRelayTemplate('{message} only')).toBeNull();
  });

  it('treats regex metacharacters in the template as literals', () => {
    // The `.` and `*` are literal here, so a real `.*` in the body must match
    // them verbatim rather than acting as a wildcard.
    const parsed = parseRelayMessage('a.*b ivan done', '{source}.*b {nick} {message}');
    expect(parsed).toEqual({ source: 'a', nick: 'ivan', text: 'done' });
    expect(parseRelayMessage('aXXb ivan done', '{source}.*b {nick} {message}')).toBeNull();
  });
});

// Marks, as the relay-bot store holds them: nick → custom template ('' means the
// built-in formats). Anything absent is not a relay bot.
const marks = (m: Record<string, string>) => (nick: string) => m[nick] ?? null;

describe('parseRelayChain — chained bridges (#801)', () => {
  // The reported line, verbatim from the corpus: `nR` bridges the IRC-nERDs
  // network, where a bot nicked `|` is itself bridging Matrix/OFTC.
  const nested =
    '\x02[IRC-nERDs]\x02 <~\x0306|\x03> \x0313<yrdsb3222[m]/OFTC> \x0fIs their a discord';

  it('stops at the intermediate bridge when only the outer bot is marked', () => {
    expect(parseRelayChain(nested, '', marks({}))).toEqual({
      source: 'IRC-nERDs',
      nick: '|',
      text: '\x0313<yrdsb3222[m]/OFTC> \x0fIs their a discord',
    });
  });

  it('reaches the real speaker once the intermediate bridge is marked too', () => {
    expect(parseRelayChain(nested, '', marks({ '|': '' }))).toEqual({
      source: 'IRC-nERDs',
      nick: 'yrdsb3222[m]/OFTC',
      text: '\x0fIs their a discord',
    });
  });

  it('leaves a quoted nick alone — quoting looks exactly like an envelope', () => {
    // Real line: raah, on efnet, quoting ultros. `ultros` carries no mark, so
    // the line stays raah's. This is the whole reason each hop needs one.
    const quote = '\x02[efnet]\x02 <+\x0303raah\x03> <\x0310ultros\x03> blasphemer! and a heretic!';
    expect(parseRelayChain(quote, '', marks({ '|': '' }))?.nick).toBe('raah');
  });

  it('follows a three-deep chain and prefers the innermost [source] tag', () => {
    // `DeltaCharlie1888` relays `nR`, which relays rizon. The rizon tag is the
    // one closest to the speaker, so it wins over the hops outside it.
    const deep = '<nR> [rizon] <Nsane> Looks like the sequel bombed';
    expect(parseRelayChain(deep, '', marks({ nR: '' }))).toEqual({
      source: 'rizon',
      nick: 'Nsane',
      text: 'Looks like the sequel bombed',
    });
  });

  it('prefers the innermost [source] when every hop carries one', () => {
    // Both tags present, so this is the case that actually pins the direction
    // of the coalesce — the tests either side of it have a tag on one hop only,
    // and pass whichever way it's written.
    expect(parseRelayChain('[A] <bridge> [B] <alice> hi', '', marks({ bridge: '' }))).toEqual({
      source: 'B',
      nick: 'alice',
      text: 'hi',
    });
  });

  it('strips a membership prefix on an inner hop too', () => {
    const line = '<+DOMF> <+Nelluk> many ghosts living and dead abound';
    expect(parseRelayChain(line, '', marks({ DOMF: '' }))).toEqual({
      source: null,
      nick: 'Nelluk',
      text: 'many ghosts living and dead abound',
    });
  });

  it("uses the inner bot's OWN custom template", () => {
    const line = '[net] <bridge> matrix » alice » hey';
    expect(parseRelayChain(line, '', marks({ bridge: '{source} » {nick} » {message}' }))).toEqual({
      source: 'matrix',
      nick: 'alice',
      text: 'hey',
    });
  });

  it('ends the chain where a marked hop speaks in its own voice', () => {
    // `bridge` is marked, but this line of its own isn't an envelope — so it
    // stays attributed to `bridge` rather than falling apart.
    const line = '[net] <bridge> reconnected to matrix';
    expect(parseRelayChain(line, '', marks({ bridge: '' }))).toEqual({
      source: 'net',
      nick: 'bridge',
      text: 'reconnected to matrix',
    });
  });

  it('terminates on a bot whose envelope names itself', () => {
    const line = '<loop> <loop> <loop> <loop> <loop> <loop> <loop> done';
    const parsed = parseRelayChain(line, '', marks({ loop: '' }));
    // Depth-capped rather than looping: it stops mid-chain, still attributed.
    expect(parsed?.nick).toBe('loop');
    expect(parsed?.text).toBe('<loop> <loop> <loop> done');
  });

  it('returns null when the outer envelope does not parse at all', () => {
    expect(parseRelayChain('just a line the bot said', '', marks({}))).toBeNull();
  });
});
