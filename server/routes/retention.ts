// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Read-only retention surface (lurker-dev/RETENTION_PLAN.md): what the
// Settings pane and the /retention slash command display. Everything here
// resolves through the same functions the sweeper enforces with, so what the
// user is told and what actually happens can never disagree. Writes go over
// the WS verb `set-buffer-retention` (per-buffer) and PATCH /api/settings
// (globals) — this router deliberately has no mutating endpoint.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  declaredRetentionCeilingLines,
  declaredEventRetentionCeilingHours,
  declaredClosedBufferCeilingDays,
  effectiveRetentionLines,
  effectiveEventRetentionHours,
} from '../services/retentionLimits.js';
import { getBufferRetentionByTarget, recentLinesPerDay } from '../db/bufferRetention.js';

const router = Router();
router.use(requireAuth);

// The operator ceilings, for the Settings UI: presets above a ceiling hide,
// and the pane says what the instance maximum is instead of letting a stored
// over-ceiling value render as if it were in effect.
router.get('/limits', (_req: Request, res: Response) => {
  res.json({
    maxLines: declaredRetentionCeilingLines(),
    maxEventHours: declaredEventRetentionCeilingHours(),
    maxClosedBufferDays: declaredClosedBufferCeilingDays(),
  });
});

// One buffer's whole retention picture: the stored override (null = inherit),
// what is actually enforced after inheritance + ceiling, the noise clock in
// effect, and the buffer's recent pace so a client can render "≈ N days at
// this buffer's recent rate".
router.get('/buffer', (req: Request, res: Response) => {
  const networkId = Number(req.query.networkId);
  const target = typeof req.query.target === 'string' ? req.query.target : '';
  if (!Number.isInteger(networkId) || networkId <= 0 || !target) {
    res.status(400).json({ error: 'networkId and target are required' });
    return;
  }
  const found = getBufferRetentionByTarget(req.user!.id, networkId, target);
  if (!found) {
    res.status(404).json({ error: 'no such buffer' });
    return;
  }
  res.json({
    bufferId: found.bufferId,
    overrideLines: found.maxLines,
    effectiveLines: effectiveRetentionLines(req.user!.id, found.bufferId),
    effectiveEventHours: effectiveEventRetentionHours(req.user!.id),
    recentLinesPerDay: recentLinesPerDay(found.bufferId),
  });
});

export default router;
