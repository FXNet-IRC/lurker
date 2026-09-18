// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What a member needs to attach an IRC client to this instance's bouncer, for
// the Settings pane. Mounted only when the bouncer runs, and behind auth: the
// port is on the public internet either way, but there's no reason to hand it
// out to anyone who asks, and /api/config is read before sign-in.
//
// `host` is null when the operator hasn't pinned an address. The bouncer can't
// sit behind the HTTP reverse proxy — it terminates its own TLS — so the web
// origin isn't reliably its address either, and the client falls back to the
// hostname the browser is on.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  bouncerPort,
  bouncerPublicAddress,
  bouncerTerminatesTls,
  bouncerTlsInfo,
} from '../utils/bouncerConfig.js';

const router = Router();
router.use(requireAuth);

router.get('/', (_req: Request, res: Response) => {
  const pinned = bouncerPublicAddress();
  res.json({
    host: pinned?.host ?? null,
    port: pinned?.port ?? bouncerPort(),
    // Whether a client should connect in TLS mode — what the operator pinned,
    // else whether Lurker itself terminates TLS.
    tls: pinned?.tls ?? bouncerTerminatesTls(),
    // A self-signed certificate is the default, and a client refuses it until
    // the member accepts or pins it — so the pane warns, with the fingerprint to
    // check against. Null when the operator pinned an address (whatever answers
    // there is theirs, not ours), when the listener isn't up, or when Lurker
    // isn't the one doing TLS.
    certificate: pinned ? null : bouncerTlsInfo(),
  });
});

export default router;
