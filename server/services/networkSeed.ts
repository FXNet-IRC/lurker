// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// Seed the single locked FXNet network for a new account, with the configured
// channels auto-joined. Shared by account provisioning (routes/provision.ts) and
// guest creation (routes/guest.ts) so both produce an identical starting network.
// No-op when the lock is off — an unlocked instance has no forced network to
// seed, so the account simply starts with none.

import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { seedAutojoinChannel } from '../db/buffers.js';
import { getForcedNetworkConfig } from '../utils/forcedNetwork.js';

/**
 * Create the forced network for `userId` using `nick` as the IRC nick (and as
 * the username/realname; under the lock the on-wire ident is overridden to the
 * stable per-account token anyway). Returns the created network, or undefined
 * when the lock is off or creation failed.
 */
export function seedForcedNetwork(userId: number, nick: string): Network | undefined {
  const cfg = getForcedNetworkConfig();
  if (!cfg.enabled) return undefined;
  const network = createNetwork(userId, {
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    tls: cfg.tls,
    nick,
    username: nick,
    realname: nick,
    autoconnect: true,
  });
  if (!network) return undefined;
  for (const channel of cfg.channels) seedAutojoinChannel(userId, network.id, channel);
  return network;
}
