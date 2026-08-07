// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getEdition } from '../utils/edition.js';
import { isNetworkLockEnabled } from '../utils/forcedNetwork.js';
import { isPublicModeEnabled } from '../utils/publicMode.js';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '../protocol.js';
import { previewsEnabled } from '../utils/previews.js';

const router = Router();

// Public, unauthenticated bootstrap config the client can read before login so
// the UI can branch on deployment edition (self-hosted vs hosted node) and other
// instance-level feature flags. Keep this lean and strictly non-sensitive — it is
// served to anyone who hits the origin. `networkLock` tells the client this
// instance binds every account to a single network, so it hides add/remove and
// the destination fields. `publicMode` tells the client anonymous guest access is
// available, so it routes unauthenticated visitors to the join-as-guest landing
// instead of /login.
//
// protocolVersion / minProtocolVersion let a native client check compatibility
// BEFORE it opens the WebSocket and render a real "update required" error instead
// of a failed connect (#569). minProtocolVersion is the oldest CLIENT this server
// serves; protocolVersion is what the server itself speaks.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    edition: getEdition(),
    networkLock: isNetworkLockEnabled(),
    publicMode: isPublicModeEnabled(),
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    // Feature flags. `linkPreviews` is off unless the operator opted in
    // (LURKER_LINK_PREVIEWS); clients use it to hide the two user settings entirely rather than
    // presenting toggles that can't do anything.
    features: {
      linkPreviews: previewsEnabled(),
    },
  });
});

export default router;
