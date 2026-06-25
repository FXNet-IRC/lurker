// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getEdition } from '../utils/edition.js';
import { isNetworkLockEnabled } from '../utils/forcedNetwork.js';

const router = Router();

// Public, unauthenticated bootstrap config the client can read before login so
// the UI can branch on deployment edition (self-hosted vs hosted node). Keep
// this lean and strictly non-sensitive — it is served to anyone who hits the
// origin. `networkLock` tells the client this instance binds every account to a
// single network, so it hides add/remove and the destination fields.
router.get('/', (_req: Request, res: Response) => {
  res.json({ edition: getEdition(), networkLock: isNetworkLockEnabled() });
});

export default router;
