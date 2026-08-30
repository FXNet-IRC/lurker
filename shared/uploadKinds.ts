// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * The kinds the uploads browser filters by (#547), and which mimes each one covers.
 *
 * Shared because BOTH sides have to answer the same question and must not drift: the
 * server builds a WHERE clause from it (db/uploadHistory.ts) and the client decides
 * whether an optimistically-inserted row belongs in the active view
 * (stores/uploads.ts). Those were two hand-written copies of one rule — the client's
 * comment said "mirrors the server's WHERE clause", which is a promise a comment
 * cannot keep.
 *
 * The kind is DERIVED from the mime, never stored. The mime is already the
 * magic-byte truth (services/contentClass.ts sniffs it), so a `kind` column would be
 * a second source of the same fact, free to disagree with it.
 */
export const UPLOAD_KINDS = ['image', 'video', 'audio', 'text'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && (UPLOAD_KINDS as readonly string[]).includes(value);
}

/**
 * Mimes a kind covers that its `<kind>/…` prefix does not.
 *
 * ⚠ JSON is the whole reason this exists. It is a text file that IANA files under
 * `application/` (RFC 8259 registers `application/json`, and there is no
 * `text/json`), so a prefix match on `text/` misses it and an uploaded `.json` is
 * invisible under every filter the browser offers — including the one it obviously
 * belongs to (#788). The alternative was inventing a `text/json` we would then be
 * sending to real object stores, which is worse than one entry in a table.
 */
const EXTRA_MIMES: Partial<Record<UploadKind, readonly string[]>> = {
  text: ['application/json'],
};

/** The exact mimes a kind covers beyond its prefix. Empty for most kinds. */
export function extraMimesForKind(kind: UploadKind): readonly string[] {
  return EXTRA_MIMES[kind] ?? [];
}

/** Does an upload of this mime belong under this kind? The single definition both
 *  the SQL filter and the client's optimistic insert are built from. */
export function mimeMatchesKind(mime: string | null | undefined, kind: UploadKind): boolean {
  const m = mime || '';
  return m.startsWith(`${kind}/`) || extraMimesForKind(kind).includes(m);
}
