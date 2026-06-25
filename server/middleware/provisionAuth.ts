// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// Authenticates the FXNet website (the signup broker) to the provisioning API
// over a pre-shared secret injected at deploy time as LURKER_PROVISION_SECRET.
// This is a SEPARATE trust channel from user sessions — it is never reachable by
// a logged-in tenant, only by our own backend after it has verified a new user's
// email. Modeled on middleware/nodeAuth.ts.

import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export function getProvisionSecret(): string | null {
  const raw = (process.env.LURKER_PROVISION_SECRET || '').trim();
  return raw || null;
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch; comparing lengths first keeps a
  // wrong-length guess from crashing the handler and leaks nothing via timing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireProvisionAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = getProvisionSecret();
  if (!expected) {
    // Fail closed: an unconfigured provisioning secret means the surface is off,
    // not open to the world.
    res.status(503).json({ error: 'provisioning API not configured' });
    return;
  }
  const match = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  const presented = match ? match[1] : '';
  if (!presented || !secretsMatch(presented, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
