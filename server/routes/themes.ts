// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// REST surface for saved theme presets. Thin like routes/bookmarks.ts — all
// validation and fan-out live in services/themesService.ts. Built-in themes
// (Dark/Light) are shared code, so they never appear here; the list is only
// the user's saved themes.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import themesService from '../services/themesService.js';

const router = Router();
router.use(requireAuth);

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get('/', (req: Request, res: Response) => {
  res.json({ items: themesService.list(req.user!.id) });
});

router.post('/', (req: Request, res: Response) => {
  const result = themesService.create(req.user!.id, {
    name: req.body?.name,
    values: req.body?.values,
  });
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.status(201).json({ theme: result.theme });
});

router.put('/:id', (req: Request<{ id: string }>, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid theme id' });
    return;
  }
  const result = themesService.update(req.user!.id, id, {
    name: req.body?.name,
    values: req.body?.values,
  });
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json({ theme: result.theme });
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid theme id' });
    return;
  }
  const result = themesService.remove(req.user!.id, id);
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

export default router;
