// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Server-side wrapper around the shared settings registry. Re-exports the
// data + shared helpers and adds validate(), used to gate writes against
// per-setting type and range constraints.

import type { SettingValue } from '../../shared/settingsRegistry.js';
import { REGISTRY, getOption, defaultsAsObject } from '../../shared/settingsRegistry.js';

export { REGISTRY, getOption, defaultsAsObject };

type ValidateResult = { ok: true; value: SettingValue } | { ok: false; error: string };

export function validate(key: string, raw: unknown): ValidateResult {
  const opt = getOption(key);
  if (!opt) return { ok: false, error: `unknown setting: ${key}` };

  switch (opt.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      return { ok: false, error: `${key} must be a boolean` };
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: `${key} must be an integer` };
      if (typeof opt.min === 'number' && n < opt.min)
        return { ok: false, error: `${key} must be >= ${opt.min}` };
      if (typeof opt.max === 'number' && n > opt.max)
        return { ok: false, error: `${key} must be <= ${opt.max}` };
      // Neutral wording on purpose: what 0 MEANS (off, unlimited, …) is the
      // option description's job — for retention "off" would be wrong, 0 keeps
      // everything.
      if (typeof opt.minNonzero === 'number' && n !== 0 && n < opt.minNonzero)
        return { ok: false, error: `${key} must be 0 or >= ${opt.minNonzero}` };
      return { ok: true, value: n };
    }
    case 'string':
    case 'secret':
    case 'color': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
      return { ok: true, value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
      if (!opt.choices?.includes(raw)) {
        return { ok: false, error: `${key} must be one of: ${opt.choices?.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'string-list': {
      if (!Array.isArray(raw)) return { ok: false, error: `${key} must be an array of strings` };
      if (!raw.every((s) => typeof s === 'string')) {
        return { ok: false, error: `${key} entries must all be strings` };
      }
      return { ok: true, value: raw as string[] };
    }
    default:
      return { ok: false, error: `unsupported type: ${(opt as { type: string }).type}` };
  }
}
