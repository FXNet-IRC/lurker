// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared shapes for the uploader-management UI (#514). The server projects these
// from each driver's own `configSchema`, so the client renders a form for a
// driver it has never heard of — adding a driver is a server-only change.
//
// The one invariant worth restating here, because it shapes every component that
// touches these types: A SECRET VALUE NEVER TRAVELS TO THE CLIENT. A secret field
// is described by the schema and reported as set-or-not via `secretsSet`; its
// value is only ever write-only. Anything that renders a `secret` field must
// therefore treat "empty" as "leave what's stored alone", not "clear it".

export interface UploaderConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret';
  required: boolean;
  default?: string;
  description: string;
}

export interface UploaderDriver {
  driver: string;
  label: string;
  configSchema: UploaderConfigField[];
  // May a NEW uploader of this driver be stood up? The server sends every driver
  // (you need a schema to render an edit form for a row you already own — e.g. a
  // `hoarder` row migrated off the legacy settings, which is editable but not
  // creatable), so the "add an uploader" menu filters on this rather than on
  // whatever happens to be in the list.
  creatable: boolean;
}

/** One configured uploader, as the user-facing API projects it. */
export interface Uploader {
  id: number;
  driver: string;
  label: string;
  scope: 'user' | 'instance';
  enabled: boolean;
  editable: boolean;
  // Present only on rows the caller may edit (their own).
  config?: Record<string, string>;
  secretsSet?: Record<string, boolean>;
}

/** An instance uploader as the ADMIN API projects it (adds the policy flags). */
export interface AdminUploader extends Omit<Uploader, 'editable'> {
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
  offeredToUsers: boolean;
  locked: boolean;
  isDefault: boolean;
  // Seeded by the boot reconcile (x0 / catbox / local disk): can be disabled, but
  // not deleted — it would just come back. The server refuses either way; this is
  // so the UI doesn't offer a button that 409s.
  builtIn: boolean;
}

/** Blank form values for a driver, honoring each field's declared default. */
export function emptyValues(driver: UploaderDriver): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of driver.configSchema) out[f.key] = f.default ?? '';
  return out;
}

/**
 * Form values seeded from an existing uploader. Secrets come back EMPTY on
 * purpose — the server never sent us the value, and an empty secret on submit
 * means "keep the stored one" (see updateUploaderConfig). So an edit that doesn't
 * touch the secret field round-trips it untouched.
 */
export function valuesFrom(
  driver: UploaderDriver,
  config: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of driver.configSchema) {
    out[f.key] = f.type === 'secret' ? '' : (config[f.key] ?? f.default ?? '');
  }
  return out;
}

/** Required fields still blank — used to disable the submit button. `existing`
 *  relaxes the check for secrets that are already stored. */
export function missingRequired(
  driver: UploaderDriver,
  values: Record<string, string>,
  secretsSet: Record<string, boolean> = {},
): boolean {
  return driver.configSchema.some((f) => {
    if (!f.required) return false;
    if (f.type === 'secret' && secretsSet[f.key]) return false; // already stored
    return !String(values[f.key] ?? '').trim();
  });
}

// What the upload route accepts: images, text, and the media we can strip metadata
// from (mp4/mov/m4v/m4a/m4b/3gp/3g2/mp3 — see server/services/contentClass.ts).
//
// This is the file PICKER's `accept` attribute, and nothing else. The drop and paste
// gates deliberately do not share it — they go through the looser isUploadableType()
// below, whose job is to ignore things that obviously aren't uploads rather than to
// enforce policy. (An earlier version of this comment claimed the two shared "ONE
// definition"; they never did, and reading it that way would make the looser gate
// look like a bug to be fixed.)
//
// Extensions are listed alongside the MIME types because browsers disagree about
// what they call an .m4a (audio/x-m4a vs audio/mp4) and macOS greys out anything
// the attribute doesn't match, with no "All Files" escape.
//
// So every accepted MIME needs its extensions listed too, or the dialog greys out a
// file the server would have taken. `.3gp`/`.3g2` are for a file HONESTLY named — the
// Samsung voice memo that motivated 3GPP support is a 3GPP container the recorder
// calls `.m4a`, so it already got through on the `.m4a` entry. `.m4b`/`.f4a`/`.f4b`
// are the three brands `audio/mp4` was added for, and have no other entry covering
// them at all.
export const ACCEPTED_FILE_TYPES = [
  'image/*',
  'text/plain',
  '.txt',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  '.mp4',
  '.mov',
  '.m4v',
  '.m4a',
  '.m4b',
  '.f4a',
  '.f4b',
  '.3gp',
  '.3g2',
  '.mp3',
].join(',');

// Deliberately LOOSER than the accepted set: the drop/paste gates exist to ignore
// things that obviously aren't uploads, not to enforce policy. The server is the
// gate, and its 415 names the problem ("webm files are not accepted — Lurker takes
// …"), which is far more useful than a drop that silently does nothing — the bug
// this replaces.
export function isUploadableType(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'text/plain'
  );
}

/** A Font Awesome icon for an upload with no thumbnail, from its MIME. The recent-
 *  uploads browser used one generic page glyph for everything, so a PDF, a song and
 *  a video were indistinguishable. */
export function iconForMime(mime: string | null | undefined): string {
  const m = mime || '';
  if (m.startsWith('video/')) return 'fa-file-video';
  if (m.startsWith('audio/')) return 'fa-file-audio';
  if (m.startsWith('image/')) return 'fa-file-image';
  if (m.startsWith('text/')) return 'fa-file-lines';
  return 'fa-file';
}

/**
 * Is there an actual choice of upload destination to make?
 *
 * A picker with one option isn't a picker. On the hosted service there is exactly
 * one uploader (the locked dropper) and personal ones are disabled, so the settings
 * pane offered the SAME destination twice — once by name, and once as the "Server
 * default" pseudo-row that resolves to it — and asked the user to choose between
 * them.
 *
 * ⚠ `allowUserDefined` counts even when there's only one uploader: you can add a
 * second, so the picker has a job to do. And a locked-down self-host that offers
 * several instance uploaders also has one. The ONLY case with no choice is "a single
 * destination that you cannot add to" — which is exactly the hosted cell.
 */
export function hasUploaderChoice(uploaderCount: number, allowUserDefined: boolean): boolean {
  return allowUserDefined || uploaderCount > 1;
}
