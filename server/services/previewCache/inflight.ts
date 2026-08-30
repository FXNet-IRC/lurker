// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The store-side resource bounds every REMOTE cache backend shares. Extracted
// from the s3 module when the dropper backend arrived, because two copies would
// mean two counters and two throttles in a process that only ever runs ONE
// backend — the ceiling is a fact about this process's outbound stores, not
// about any particular bucket.

/**
 * Stores whose bytes are still moving — staged, hashing, or mid-send.
 *
 * ⚠ Module state rather than a field on the config, because the config is a plain
 * value that is re-resolved by tests and the bound has to survive that. One
 * process, one backend, one ceiling.
 */
let storesInFlight = 0;
/** Generous next to `mediaPool`'s 24, because these are meant to be short — the
 *  ceiling is a backstop against a stalled remote, not a throughput knob. */
const MAX_STORES_IN_FLIGHT = 16;

/**
 * Claim a store slot, or null at the ceiling.
 *
 * ⚠ DECLINED at the ceiling, never queued. A queue would bound the sockets and
 * not the staged files, and would make an already-slow remote slower still;
 * declining is free, because the reader has their bytes and all that is lost is
 * the saving on the next read. The returned settle is idempotent — commit and
 * abort paths can both call it without double-freeing the slot.
 */
export function tryAcquireStoreSlot(): (() => void) | null {
  if (storesInFlight >= MAX_STORES_IN_FLIGHT) return null;
  storesInFlight++;
  let settled = false;
  return (): void => {
    if (settled) return;
    settled = true;
    storesInFlight--;
  };
}

/** Test seam: the bound is invisible from outside until it bites. */
export function storesInFlightForTests(): number {
  return storesInFlight;
}

/**
 * ⚠ A cache is not a failure path, but a cache that fails FOREVER and SILENTLY is
 * an operator support burden. Config validation only proves the env vars are
 * present — a wrong secret, a policy denial, a typo'd bucket or endpoint all
 * resolve to a working-looking mode where every store fails, nothing populates,
 * and no line is ever logged. `local` at least leaves errno-shaped evidence on
 * the volume.
 *
 * ⚠ Throttled to once a minute, and deliberately not per-key: the failure mode
 * this exists for is EVERY store failing, so an unthrottled warning would be one
 * line per image request in the log of a server that is otherwise fine.
 */
let lastWarnAt = 0;

/** Test seam: the throttle is global, so one test warning silences the next. */
export function resetWarnThrottleForTests(): void {
  lastWarnAt = 0;
}

export function warnOnce(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[preview-cache] ${message}`);
}
