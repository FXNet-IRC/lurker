// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Discord-style `||spoiler||` → IRC spoiler codes, applied to outgoing plain
// messages. A spoiler on the wire is a run whose foreground and background
// colour are identical — invisible text in any IRC client, which Lurker's
// renderer (splitTextByTokens in nickColor.ts) upgrades into a click-to-reveal
// box. Closing with a bare \x03 resets the colour without disturbing any
// bold/italic still in effect.
//
// ⚠ GREY on grey (14,14), not black on black. Any matching pair hides the text,
// so this is purely about what the box looks like to a Lurker reader — and the
// renderer paints the box in the colour it was sent, because an fg==bg run is
// not reliably a spoiler (ASCII art fills solid blocks the same way, and
// second-guessing it recolours the picture). That honesty is only affordable if
// what WE emit is a colour that reads as a box on both canvases, and grey is
// the only one that does:
//
//   slot 14 grey     4.05:1 on the dark canvas, 3.68:1 on the light
//   slot 1  black    1.29:1 dark  — a black box on #212022 is barely there
//   slot 0  white    1.09:1 light — likewise, mirrored
//
// Receiving is unchanged and unaffected: every fg==bg pair is still detected,
// so spoilers from clients that send 01,01 keep working.
//
// `\||` is an escape: it emits a literal `||` and never acts as a delimiter,
// so a message that genuinely needs a double-pipe (`exit code \|| 1`) can opt
// out. There is no escape for the backslash itself — a lone `\` is always
// literal, so `\||` is the only sequence treated specially.

const SPOILER_OPEN = '\x0314,14';
const SPOILER_CLOSE = '\x03';

// ⚠⚠ The close needs help when a digit follows it. A bare \x03 is a colour RESET only when
// nothing parseable comes next — \x03 then a digit is a colour CODE, and it eats up to two of
// them. `||spoiler||5 stars` went out as `…spoiler\x035 stars` and arrived as " stars" in colour
// 5, still on the spoiler's background, the "5" simply deleted; `the code is ||1234||5678` lost
// "56" and rendered the rest in colour 56. Silent, on the wire, unrecoverable.
//
// 99 is IRC's "default colour" and, being two digits, consumes the parser's whole appetite so the
// typed digit survives as text. Both halves are specified: a bare \x0399 sets only the foreground
// and would leave the rest of the line sitting on the spoiler's grey box.
//
// ⚠ Not \x0F (reset-all), which would also drop any bold or italic still in effect around the
// spoiler — the one thing the bare \x03 close was chosen to preserve. And not used
// unconditionally: it's six bytes heavier and 99 is less universally understood than a reset, so
// only the collision pays for it.
//
// ⚠ This depends on splitTextByTokens NOT treating 99,99 as a spoiler — see the renderable-slot
// check there. Without it every spoiler followed by a digit would turn the REST OF THE LINE into
// a spoiler box.
const SPOILER_CLOSE_BEFORE_DIGIT = '\x0399,99';

function spoilerClose(next: string | undefined): string {
  return next !== undefined && next >= '0' && next <= '9'
    ? SPOILER_CLOSE_BEFORE_DIGIT
    : SPOILER_CLOSE;
}

interface Token {
  delim: boolean;
  value: string;
}

// Split into literal-text and `||`-delimiter tokens, resolving `\||` escapes
// into a literal `||` inside the text tokens as we go.
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === '|' && text[i + 2] === '|') {
      buf += '||';
      i += 3;
      continue;
    }
    if (text[i] === '|' && text[i + 1] === '|') {
      if (buf) {
        tokens.push({ delim: false, value: buf });
        buf = '';
      }
      tokens.push({ delim: true, value: '||' });
      i += 2;
      continue;
    }
    buf += text[i++];
  }
  if (buf) tokens.push({ delim: false, value: buf });
  return tokens;
}

// Rewrite every `||spoiler||` pair in `text` into IRC spoiler codes. Pairing
// is non-greedy (the nearest closing `||` wins) and an empty pair (`||||`) is
// left literal, matching how Discord treats both cases.
export function applySpoilerMarkup(text: string): string {
  if (!text.includes('||')) return text;
  const tokens = tokenize(text);
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.delim) {
      out += tok.value;
      i++;
      continue;
    }
    // An opening `||`: gather everything up to the next delimiter.
    let content = '';
    let close = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].delim) {
        close = j;
        break;
      }
      content += tokens[j].value;
    }
    if (close !== -1 && content.length > 0) {
      // What follows decides how the spoiler has to be closed. The next character is the first
      // of the next text token, if there is one; a delimiter or the end of the message can't be
      // a digit.
      const following = tokens[close + 1];
      const next = following && !following.delim ? following.value[0] : undefined;
      out += SPOILER_OPEN + content + spoilerClose(next);
      i = close + 1;
    } else {
      // Unmatched, or an empty `||||` — the opening `||` is just literal text.
      out += '||';
      i++;
    }
  }
  return out;
}
