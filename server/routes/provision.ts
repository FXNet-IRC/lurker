// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// FXNet account provisioning. Our website owns signup + email verification; once
// an address is verified it calls this secret-guarded API to create the matching
// lurker-native account (username + password live here) and seed the one locked
// FXNet network. A logged-in tenant can never reach these routes — they require
// the provisioning secret, a separate trust channel (see middleware/provisionAuth).

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireProvisionAuth } from '../middleware/provisionAuth.js';
import { isValidUsername } from '../utils/username.js';
import {
  isValidPassword,
  passwordRequirementsMessage,
  hashPassword,
} from '../services/password.js';
import { createUser, findUserByUsername, setPasswordHash, deleteUser } from '../db/users.js';
import { createNetwork, upsertChannel } from '../db/networks.js';
import { getForcedNetworkConfig } from '../utils/forcedNetwork.js';

const router = Router();
router.use(requireProvisionAuth);

/**
 * Seed the single locked FXNet network for a freshly provisioned account, with
 * the user's nick defaulting to their username and the configured channels
 * auto-joined. No-op when the lock is off (an unlocked instance has no forced
 * network to seed — the account simply starts with none).
 */
function seedForcedNetwork(userId: number, username: string): void {
  const cfg = getForcedNetworkConfig();
  if (!cfg.enabled) return;
  const network = createNetwork(userId, {
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    tls: cfg.tls,
    nick: username,
    username,
    realname: username,
    autoconnect: true,
  });
  if (!network) return;
  for (const channel of cfg.channels) upsertChannel(network.id, channel, true);
}

// Availability/validity probe for the signup form — lets the website surface
// "username taken" before it asks the user to set a password.
router.get('/check', (req: Request, res: Response) => {
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (!isValidUsername(username)) {
    res.json({ valid: false, available: false });
    return;
  }
  res.json({ valid: true, available: !findUserByUsername(username) });
});

// Provision a verified account. Role is always 'user' (the operator's admin is
// created separately and must never come from this path). Same username/password
// rules as lurker's own auth, so the account is valid everywhere it surfaces.
router.post('/users', (req: Request, res: Response) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!isValidUsername(username)) {
    res.status(400).json({ error: 'invalid username' });
    return;
  }
  if (!isValidPassword(password)) {
    res.status(400).json({ error: passwordRequirementsMessage() });
    return;
  }
  if (findUserByUsername(username)) {
    res.status(409).json({ error: 'username already exists' });
    return;
  }

  const user = createUser(username); // role defaults to 'user'
  try {
    setPasswordHash(user.id, hashPassword(password));
    seedForcedNetwork(user.id, username);
  } catch (err) {
    // Roll the half-created account back so a retry isn't blocked by a 409 on a
    // username whose password/network never landed.
    deleteUser(user.id);
    throw err;
  }

  res.status(201).json({ id: user.id, username: user.username });
});

export default router;
