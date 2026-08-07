// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Query layer for user_themes — saved theme presets (snapshots of the `themed`
// settings-registry keys). Validation and cross-device fan-out live in
// services/themesService.ts; this file is SQL only, per-user scoped throughout.

import type { SettingValue } from '../../shared/settingsRegistry.js';
import db from './index.js';

export interface ThemeRow {
  id: number;
  name: string;
  values: Record<string, SettingValue>;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: number;
  name: string;
  values_json: string;
  created_at: string;
  updated_at: string;
}

function toTheme(row: RawRow): ThemeRow | null {
  let values: unknown;
  try {
    values = JSON.parse(row.values_json);
  } catch {
    return null; // malformed row — treat as absent, like db/settings.ts does
  }
  // JSON.parse succeeding isn't enough: `null`, an array, or a bare scalar all
  // parse fine and none is a {key: value} map. Same treatment as unparseable.
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  return {
    id: row.id,
    name: row.name,
    values: values as Record<string, SettingValue>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listThemesForUser(userId: number): ThemeRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, values_json, created_at, updated_at
         FROM user_themes WHERE user_id = ? ORDER BY name COLLATE NOCASE`,
    )
    .all(userId) as RawRow[];
  return rows.map(toTheme).filter((t): t is ThemeRow => t !== null);
}

export function getTheme(userId: number, id: number): ThemeRow | null {
  const row = db
    .prepare(
      `SELECT id, name, values_json, created_at, updated_at
         FROM user_themes WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id) as RawRow | undefined;
  return row ? toTheme(row) : null;
}

export function findThemeByName(userId: number, name: string): ThemeRow | null {
  // name is COLLATE NOCASE in the schema, so = matches case-insensitively.
  const row = db
    .prepare(
      `SELECT id, name, values_json, created_at, updated_at
         FROM user_themes WHERE user_id = ? AND name = ?`,
    )
    .get(userId, name) as RawRow | undefined;
  return row ? toTheme(row) : null;
}

export function countThemesForUser(userId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM user_themes WHERE user_id = ?').get(userId) as {
    n: number;
  };
  return row.n;
}

export function createTheme(
  userId: number,
  name: string,
  values: Record<string, SettingValue>,
): ThemeRow {
  const info = db
    .prepare('INSERT INTO user_themes (user_id, name, values_json) VALUES (?, ?, ?)')
    .run(userId, name, JSON.stringify(values));
  return getTheme(userId, Number(info.lastInsertRowid))!;
}

export function updateTheme(
  userId: number,
  id: number,
  fields: { name?: string; values?: Record<string, SettingValue> },
): ThemeRow | null {
  const existing = getTheme(userId, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE user_themes
        SET name = ?, values_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND id = ?`,
  ).run(fields.name ?? existing.name, JSON.stringify(fields.values ?? existing.values), userId, id);
  return getTheme(userId, id);
}

export function deleteTheme(userId: number, id: number): boolean {
  const info = db.prepare('DELETE FROM user_themes WHERE user_id = ? AND id = ?').run(userId, id);
  return info.changes > 0;
}
