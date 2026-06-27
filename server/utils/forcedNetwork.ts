// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// FXNet customization: lock every account to a single, operator-defined IRC
// network (irc.fxnet.org) instead of letting users connect anywhere. This is
// what turns upstream Lurker — a bring-your-own-network client — into a
// community client bound to one network.
//
// Enforcement is layered and this module is the single source of truth for all
// of it:
//   - the connect chokepoint (ircConnection) calls resolveConnectTarget() so the
//     socket ALWAYS dials the forced host/port regardless of the stored row —
//     the real security wall;
//   - the network write routes consult isNetworkLockEnabled() to refuse new
//     networks and ignore destination edits;
//   - provisioning seeds exactly this one network per account.
//
// Config is read once from the environment and cached for the process lifetime,
// matching utils/edition.ts. A standalone upstream deploy that never sets
// LURKER_LOCK_NETWORKS stays completely unlocked — this is a zero-impact addition.

const DEFAULT_NAME = 'FXNet';
const DEFAULT_PORT = 6697;
const DEFAULT_CHANNELS = ['#chat', '#help', '#fxnet'];

export interface ForcedNetworkConfig {
  /** Operator opted in (LURKER_LOCK_NETWORKS=true) AND a host is configured. */
  enabled: boolean;
  /** Display name of the seeded network. */
  name: string;
  /** Destination host every account is bound to. */
  host: string;
  /** Destination port (default 6697). */
  port: number;
  /** Connect over TLS (default true). */
  tls: boolean;
  /** Verify the server certificate when using TLS (default true). */
  verifyTls: boolean;
  /** Channels auto-joined on the seeded network. */
  channels: string[];
  /**
   * Shared secret sent in the WEBIRC command, matching the InspIRCd
   * `<gateway type="webirc" password>` block. Empty disables WEBIRC.
   */
  webircPassword: string;
  /**
   * Gateway name sent as the WEBIRC `gateway` field, matching the IRCd's
   * `<connect:webirc>` / extban gateway name. Defaults to the network name.
   */
  webircGateway: string;
}

/**
 * Parse a forced-network config from a raw env bag. Pure (no process.env access)
 * so the rules are directly unit-testable. `enabled` requires both the opt-in
 * flag and a non-empty host — a lock with no destination would simply break all
 * connections, so we treat that misconfiguration as "not locked" and warn at the
 * call site rather than here (keeping this pure).
 */
export function parseForcedNetworkConfig(
  env: Record<string, string | undefined>,
): ForcedNetworkConfig {
  const optedIn = (env.LURKER_LOCK_NETWORKS ?? '').trim().toLowerCase() === 'true';
  const host = (env.LURKER_FORCED_NETWORK_HOST ?? '').trim();
  const name = (env.LURKER_FORCED_NETWORK_NAME ?? '').trim() || DEFAULT_NAME;

  const rawPort = (env.LURKER_FORCED_NETWORK_PORT ?? '').trim();
  const parsedPort = Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

  // TLS and cert verification both default ON; only an explicit '0'/'false' opts
  // out, so a missing var is the safe choice.
  const tls = !isFalsey(env.LURKER_FORCED_NETWORK_TLS);
  const verifyTls = !isFalsey(env.LURKER_FORCED_NETWORK_TLS_VERIFY);

  // An undefined var means "use the FXNet defaults"; a defined-but-empty var is
  // an explicit "no auto-join channels", so we distinguish the two.
  const rawChannels = env.LURKER_FORCED_NETWORK_CHANNELS;
  const channels =
    rawChannels === undefined
      ? [...DEFAULT_CHANNELS]
      : rawChannels
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);

  const webircPassword = (env.LURKER_WEBIRC_PASSWORD ?? '').trim();
  const webircGateway = (env.LURKER_WEBIRC_GATEWAY ?? '').trim() || name;

  return {
    enabled: optedIn && host !== '',
    name,
    host,
    port,
    tls,
    verifyTls,
    channels,
    webircPassword,
    webircGateway,
  };
}

function isFalsey(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no';
}

let cached: ForcedNetworkConfig | null = null;

/** The resolved forced-network config for this process (cached after first call). */
export function getForcedNetworkConfig(): ForcedNetworkConfig {
  if (cached === null) {
    cached = parseForcedNetworkConfig(process.env);
    if (
      !cached.enabled &&
      (process.env.LURKER_LOCK_NETWORKS ?? '').trim().toLowerCase() === 'true'
    ) {
      console.warn(
        '[lurker] LURKER_LOCK_NETWORKS=true but LURKER_FORCED_NETWORK_HOST is unset — network lock is INACTIVE until a host is configured.',
      );
    }
  }
  return cached;
}

/** True when accounts are bound to the single forced network. */
export function isNetworkLockEnabled(): boolean {
  return getForcedNetworkConfig().enabled;
}

/** Reset the cache. Test-only — production reads the env exactly once. */
export function resetForcedNetworkCacheForTests(): void {
  cached = null;
}

/** WEBIRC credentials to forward each user's real IP to the IRCd. */
export interface WebircConfig {
  password: string;
  gateway: string;
}

/**
 * WEBIRC config for this process, or null when unconfigured (no password). When
 * null, connections send no WEBIRC command and behave exactly as before — so a
 * misconfigured or opted-out deploy degrades to "no real-IP forwarding" rather
 * than a broken registration handshake.
 */
export function getWebircConfig(): WebircConfig | null {
  const cfg = getForcedNetworkConfig();
  if (!cfg.webircPassword) return null;
  return { password: cfg.webircPassword, gateway: cfg.webircGateway };
}

/** The destination + TLS settings irc-framework should dial for one connection. */
export interface ConnectTarget {
  host: string;
  port: number;
  tls: boolean;
  rejectUnauthorized: boolean;
}

/**
 * Resolve where a connection should actually go. When the lock is active the
 * forced host/port/TLS win over whatever is stored on the network row — so even
 * a tampered or legacy row can only ever reach the FXNet network. When the lock
 * is off this is exactly upstream behavior, read from the row.
 */
export function resolveConnectTarget(network: {
  host: string;
  port: number;
  tls: number | boolean;
  trusted_certificates: number | boolean;
}): ConnectTarget {
  const cfg = getForcedNetworkConfig();
  if (cfg.enabled) {
    return {
      host: cfg.host,
      port: cfg.port,
      tls: cfg.tls,
      rejectUnauthorized: cfg.tls && cfg.verifyTls,
    };
  }
  return {
    host: network.host,
    port: network.port,
    tls: !!network.tls,
    rejectUnauthorized:
      network.trusted_certificates !== 0 && network.trusted_certificates !== false,
  };
}
