// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/** Conventional truthy env values — trimmed + case-insensitive. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parse a raw environment value to a boolean, the same way everywhere.
 *
 * Pure (no env access) so the rule is unit-testable, and shared so an operator who learns that
 * `on` works for one flag doesn't discover it silently doesn't for another. Unset, empty, and
 * anything unrecognised are all OFF: every flag that reads this is an opt-in, and a
 * misunderstood value must fail closed rather than guess.
 */
export function parseTruthyEnv(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? '').trim().toLowerCase());
}
