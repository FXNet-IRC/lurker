// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { REGISTRY } from '../services/settingsRegistry.js';
import { getUserSettings } from '../db/settings.js';
import { listThemesForUser } from '../db/themes.js';
import settingsService from '../services/settingsService.js';

const router = Router();
router.use(requireAuth);

router.get('/bootstrap', (req: Request, res: Response) => {
  res.json({
    registry: REGISTRY,
    values: getUserSettings(req.user!.id),
    // Saved themes ride the same response so the theme resolver never renders a
    // frame with values loaded but the pointed-at theme still in flight.
    themes: listThemesForUser(req.user!.id),
  });
});

router.patch('/', (req: Request, res: Response) => {
  const changes = req.body?.changes ?? {};
  const resets = req.body?.resets ?? [];
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    res.status(400).json({ error: 'changes must be an object of { key: value }' });
    return;
  }
  if (!Array.isArray(resets) || !resets.every((k: unknown) => typeof k === 'string')) {
    res.status(400).json({ error: 'resets must be an array of setting keys' });
    return;
  }
  if (Object.keys(changes).length === 0 && resets.length === 0) {
    res.status(400).json({ error: 'nothing to change: pass changes and/or resets' });
    return;
  }
  const result = settingsService.update(req.user!.id, changes, resets);
  if (!result.ok) {
    res.status(400).json({ error: result.error, key: result.key });
    return;
  }
  res.json({ values: result.values });
});

router.delete('/:key', (req: Request<{ key: string }>, res: Response) => {
  const result = settingsService.reset(req.user!.id, req.params.key);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ values: result.values });
});

export default router;
