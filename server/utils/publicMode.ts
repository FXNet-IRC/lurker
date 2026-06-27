// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// FXNet public webchat mode. When enabled, visitors can join the chat with NO
// account (The Lounge / KiwiIRC style): an ephemeral guest user row is created
// on demand, seeded with the forced network, auto-connected, and reaped once
// idle. Guests can later claim their row into a permanent account.
//
// This is opt-in and orthogonal to the network lock — though in practice a
// public deployment runs with both on (a public webchat is bound to one
// network). Config is read once from the environment and cached for the process
// lifetime, matching utils/edition.ts and utils/forcedNetwork.ts. An instance
// that never sets LURKER_PUBLIC_MODE stays fully account-gated — zero impact.

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_RATELIMIT_PER_IP = 5;

export interface PublicModeConfig {
  /** Operator opted in (LURKER_PUBLIC_MODE=true). */
  enabled: boolean;
  /** Minutes a guest may be idle (no live socket) before it is reaped. */
  idleMinutes: number;
  /** Max guest creations allowed per client IP per hour. */
  rateLimitPerIp: number;
}

/**
 * Parse a public-mode config from a raw env bag. Pure (no process.env access) so
 * the rules are directly unit-testable.
 */
export function parsePublicModeConfig(env: Record<string, string | undefined>): PublicModeConfig {
  const enabled = (env.LURKER_PUBLIC_MODE ?? '').trim().toLowerCase() === 'true';
  return {
    enabled,
    idleMinutes: positiveIntOr(env.LURKER_GUEST_IDLE_MINUTES, DEFAULT_IDLE_MINUTES),
    rateLimitPerIp: positiveIntOr(env.LURKER_GUEST_RATELIMIT_PER_IP, DEFAULT_RATELIMIT_PER_IP),
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

let cached: PublicModeConfig | null = null;

/** The resolved public-mode config for this process (cached after first call). */
export function getPublicModeConfig(): PublicModeConfig {
  if (cached === null) cached = parsePublicModeConfig(process.env);
  return cached;
}

/** True when anonymous guest access is enabled on this instance. */
export function isPublicModeEnabled(): boolean {
  return getPublicModeConfig().enabled;
}

/** Minutes a guest may be idle before the reaper deletes it. */
export function guestIdleMinutes(): number {
  return getPublicModeConfig().idleMinutes;
}

/** Max guest creations per client IP per hour. */
export function guestRateLimit(): number {
  return getPublicModeConfig().rateLimitPerIp;
}

/** Reset the cache. Test-only — production reads the env exactly once. */
export function resetPublicModeCacheForTests(): void {
  cached = null;
}
