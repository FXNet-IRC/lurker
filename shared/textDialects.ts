// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * The text dialects: signature-less UTF-8 we are willing to NAME, rather than
 * flattening to `.txt` (#788).
 *
 * These bytes have always been accepted — a `.md` is UTF-8 with no signature, which
 * is exactly what the server's text branch takes — so this widens nothing about what
 * may be uploaded. All it changes is the label: a README came back as `README.txt`,
 * and a `.json` lost the one thing that told an editor how to read it.
 *
 * ⚠ This is the ONE deliberate relaxation of "the ext is NEVER the client's claim"
 * (services/contentClass.ts). That rule exists so a user's `.html` cannot become the
 * served extension, and it is preserved by the SHAPE of this table, not by the source
 * of the answer: the extension can only ever be one of these three values, whatever
 * the caller says. Adding an entry is therefore a real security decision — the type
 * must be inert when served from an uploads domain, the bar SVG fails. Neither
 * markdown nor JSON renders as anything active in a browser: they display or
 * download, and the pinned Content-Type never comes from the caller.
 *
 * Shared because the CLIENT needs the extension half too, and for the same portability
 * reason the server does. Its paste/drop gate sees only `File.type`, which on a
 * platform with no registered mime for `.md` is `''` or `application/octet-stream` —
 * so a hand-copied list here would silently ignore the exact files the server's
 * fallback exists to accept, and would rot the first time a dialect is added.
 */
export interface TextDialect {
  mime: string;
  ext: string;
}

export const PLAIN_TEXT: TextDialect = { mime: 'text/plain', ext: 'txt' };
const MARKDOWN: TextDialect = { mime: 'text/markdown', ext: 'md' };
const JSON_TEXT: TextDialect = { mime: 'application/json', ext: 'json' };

export const TEXT_DIALECT_BY_MIME = new Map<string, TextDialect>([
  ['text/plain', PLAIN_TEXT],
  ['text/markdown', MARKDOWN],
  ['application/json', JSON_TEXT],
]);

/**
 * The same three, keyed by filename extension — a SECOND signal, needed because the
 * first is not portable.
 *
 * macOS and Linux register a mime for `.md` and browsers send `text/markdown`.
 * Windows registers none, so the same file arrives as `text/plain`,
 * `application/octet-stream` or nothing at all — and the feature would simply not
 * work there, silently, on the platform least likely to be tested.
 */
const TEXT_DIALECT_BY_EXT = new Map<string, TextDialect>([
  ['txt', PLAIN_TEXT],
  ['md', MARKDOWN],
  ['markdown', MARKDOWN],
  ['json', JSON_TEXT],
]);

/** The dialect a filename's extension names, if it names one at all. */
export function dialectFromFilename(filename: string): TextDialect | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return TEXT_DIALECT_BY_EXT.get(filename.slice(dot + 1).toLowerCase());
}

/**
 * Does this filename look like one of the dialects?
 *
 * The client's read of the same table: its paste/drop gate has a filename and an
 * unreliable mime, and needs to decide whether to hand the file to the server at all.
 * ⚠ A HINT, never a verdict — the server re-derives everything from the bytes, and
 * this returning true does not mean the upload will be accepted.
 */
export function hasTextDialectExtension(filename: string): boolean {
  return dialectFromFilename(filename) !== undefined;
}
