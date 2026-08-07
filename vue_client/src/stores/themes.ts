// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Theme presets: the built-in Dark/Light themes (shared/themePresets.ts) plus
// the user's saved themes (/api/themes), and the resolver that picks the
// active one. The settings store consults `activeThemeValues` when resolving a
// `themed` key with no per-key override — override → active theme → registry
// default. Which theme is active comes from the look.theme.* pointer settings;
// in 'system' mode the pointer is chosen per device via prefers-color-scheme.
//
// Saved themes hydrate from the settings bootstrap (same response as the
// values, so a pointer never resolves against a list that hasn't arrived) and
// refetch on the 'themes-changed' socket frame.

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { SettingValue } from '../../../shared/settingsRegistry.js';
import { THEMED_KEYS } from '../utils/settingsRegistry.js';
import type { ThemePreset } from '../../../shared/themePresets.js';
import { builtinThemes, getBuiltinTheme } from '../../../shared/themePresets.js';
import { prefersDark } from '../utils/prefersDark.js';
import { useSettingsStore } from './settings.js';

/** A saved /api/themes row, as the server returns it. */
export interface SavedTheme {
  id: number;
  name: string;
  values: Record<string, SettingValue>;
  createdAt: string;
  updatedAt: string;
}

function asPreset(t: SavedTheme): ThemePreset {
  return { id: String(t.id), name: t.name, builtin: false, values: t.values };
}

export const useThemesStore = defineStore('themes', {
  state: () => ({
    saved: [] as SavedTheme[],
    loaded: false,
  }),
  getters: {
    /** Built-ins first (Dark, Light), then saved themes (server keeps them name-sorted). */
    all(state): ThemePreset[] {
      return [...builtinThemes(), ...state.saved.map(asPreset)];
    },
    byId(): (id: string) => ThemePreset | null {
      return (id: string) => this.all.find((t) => t.id === id) || null;
    },
    /** The pointer setting the current mode/device resolves through. */
    activePointerKey(): string {
      const settings = useSettingsStore();
      if (settings.effective('look.theme.mode') === 'system') {
        return prefersDark.value ? 'look.theme.dark' : 'look.theme.light';
      }
      return 'look.theme.active';
    },
    /** Resolved active theme id; a dangling pointer falls back to built-in Dark. */
    activeThemeId(): string {
      const settings = useSettingsStore();
      const id = String(settings.effective(this.activePointerKey) ?? 'dark');
      return this.byId(id) ? id : 'dark';
    },
    activeTheme(): ThemePreset {
      return this.byId(this.activeThemeId) || getBuiltinTheme('dark')!;
    },
    /**
     * The value layer effective() consults for themed keys — null for built-in
     * Dark, whose values ARE the registry defaults, so the resolver can skip
     * the layer entirely (the pre-themes fast path every existing user is on).
     */
    activeThemeValues(): Record<string, SettingValue> | null {
      return this.activeThemeId === 'dark' ? null : this.activeTheme.values;
    },
  },
  actions: {
    /** Seed from the settings bootstrap payload (no extra round-trip). */
    hydrate(items: SavedTheme[]) {
      this.saved = items;
      this.loaded = true;
    },
    async fetchAll() {
      const { items } = await api('/api/themes');
      this.hydrate(items);
    },
    /** Every themed key at its currently-rendered value (theme + drift), for saving. */
    snapshotCurrent(): Record<string, SettingValue> {
      const settings = useSettingsStore();
      const out: Record<string, SettingValue> = {};
      for (const key of THEMED_KEYS) {
        const value = settings.effective(key);
        if (value !== undefined) out[key] = value as SettingValue;
      }
      return out;
    },
    /**
     * Point at a theme and clear every themed override in one PATCH, so the
     * theme applies unmodified and atomically. In system mode this assigns the
     * slot this device is currently rendering (you apply what you can see).
     */
    async applyTheme(id: string) {
      const settings = useSettingsStore();
      await settings.patchMany({ [this.activePointerKey]: id }, [...THEMED_KEYS]);
    },
    /**
     * Snapshot the current look (active theme + drift) into a NEW theme and
     * make it active. The ordering is load-bearing — snapshot BEFORE
     * applyTheme, which clears the very overrides being saved — so it lives
     * here once; every surface (GUI, /theme, the future editor) calls this
     * rather than re-deriving the sequence.
     */
    async saveCurrentAs(name: string): Promise<SavedTheme> {
      const values = this.snapshotCurrent();
      const created = await this.create(name, values);
      await this.applyTheme(String(created.id));
      return created;
    },
    /** Same sequence, into an EXISTING theme (overwrite its values, re-point at it). */
    async saveCurrentInto(id: number): Promise<SavedTheme> {
      const values = this.snapshotCurrent();
      const updated = await this.update(id, { values });
      await this.applyTheme(String(id));
      return updated;
    },
    async create(name: string, values: Record<string, SettingValue>): Promise<SavedTheme> {
      const { theme } = await api('/api/themes', { method: 'POST', body: { name, values } });
      await this.fetchAll();
      return theme;
    },
    async update(
      id: number,
      fields: { name?: string; values?: Record<string, SettingValue> },
    ): Promise<SavedTheme> {
      const { theme } = await api(`/api/themes/${id}`, { method: 'PUT', body: fields });
      await this.fetchAll();
      return theme;
    },
    async remove(id: number) {
      await api(`/api/themes/${id}`, { method: 'DELETE' });
      // The server resets any pointer that dangled; its settings broadcast and
      // themes-changed frame follow. Refresh the list now for this tab.
      await this.fetchAll();
    },
  },
});
