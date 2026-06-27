// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// FXNet public webchat: anonymous guest access. Visitors POST here to join with
// no account — we create an ephemeral guest user (is_guest=1), seed the locked
// FXNet network, open a session, and connect to IRC right away (forwarding their
// real IP via WEBIRC). Guests are reaped once idle (services/guestReaper) and can
// later claim a permanent account (routes/auth claim/*) keeping their settings.
//
// Mounted unconditionally; every route fails closed with 404 unless
// LURKER_PUBLIC_MODE is enabled, so an instance that doesn't run a public
// webchat never exposes a usable surface here.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { randomInt } from 'crypto';
import { isPublicModeEnabled, guestRateLimit } from '../utils/publicMode.js';
import { createGuestUser, deleteUser, findUserByUsername } from '../db/users.js';
import { seedForcedNetwork } from '../services/networkSeed.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE, getCookieOptions } from '../middleware/auth.js';
import { normalizeIp } from '../utils/clientIp.js';
import ircManager from '../services/ircManager.js';

const router = Router();

// Gate the whole router on public mode. 404 (not 403) so a non-public instance
// looks like the endpoint simply doesn't exist.
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isPublicModeEnabled()) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  next();
});

// In-memory per-IP rate limiter for guest creation. A single-process cell only;
// it resets on restart, which is acceptable for an abuse speed-bump (the reaper
// bounds total growth regardless). Keyed on the real client IP (req.ip, which is
// trustworthy only behind a configured trusted proxy — see utils/clientIp).
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const limit = guestRateLimit();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// Reduce a requested nick to a valid IRC nick, or '' if nothing usable remains.
// IRC nicks can't contain spaces, can't start with a digit, and we cap the
// length; collisions on the network are resolved by the connection's existing
// nick-fallback ladder, so we only need basic sanitation here.
function sanitizeNick(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let n = raw.trim().replace(/[^A-Za-z0-9_\-[\]{}\\^|`]/g, '');
  n = n.replace(/^[0-9-]+/, ''); // can't start with a digit or hyphen
  return n.slice(0, 16);
}

function randomGuestNick(): string {
  return `Guest${randomInt(10000, 100000)}`;
}

// A valid, unique internal account username for the guest. Distinct from the
// IRC-visible nick; only used as the users.username handle until/unless claimed.
function uniqueGuestUsername(): string {
  for (let i = 0; i < 20; i += 1) {
    const candidate = `guest-${randomInt(100000, 1000000)}`;
    if (!findUserByUsername(candidate)) return candidate;
  }
  throw new Error('could not allocate a unique guest username');
}

router.post('/', (req: Request, res: Response) => {
  const ip = normalizeIp(req.ip);
  if (rateLimited(ip || 'unknown')) {
    res.status(429).json({ error: 'too many guest sessions, try again later' });
    return;
  }

  const nick = sanitizeNick(req.body?.nick) || randomGuestNick();
  const username = uniqueGuestUsername();
  const user = createGuestUser(username);

  let network;
  try {
    network = seedForcedNetwork(user.id, nick);
    if (!network) {
      // Public mode with no forced network is a misconfiguration — a public
      // webchat has nothing to connect to. Roll the guest back and surface it.
      deleteUser(user.id);
      res.status(503).json({ error: 'public chat is not configured' });
      return;
    }
  } catch (err) {
    deleteUser(user.id);
    throw err;
  }

  const { token } = createSession(user.id);
  res.cookie(SESSION_COOKIE, token, getCookieOptions());
  // Connect immediately, forwarding the guest's real IP via WEBIRC.
  ircManager.startNetwork(user.id, network.id, { clientIp: ip });

  res.status(201).json({
    user: { id: user.id, username: user.username, role: user.role, is_guest: true },
    nick,
  });
});

export default router;
