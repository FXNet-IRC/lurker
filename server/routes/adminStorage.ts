// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin storage stats (lurker-dev/RETENTION_PLAN.md §3.4): the visibility
// half of the abuse story. The plan deliberately ships NO per-account quotas
// — this pane is how the operator finds out whether anyone is actually
// farming buffers before any automated defense gets designed. Mounted under
// routes/admin.ts, so requireAuth + requireAdmin are inherited.
//
// The heavy walk (every stored row, attributed per account) lives in
// db/storageStats.ts, chunked with event-loop yields so no synchronous slice
// scales with instance size. Results are cached for a minute and built
// single-flight; `?refresh=1` busts the cache for the admin who just deleted
// an account and wants to see the reclaim NOW.

import fs from 'fs';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { DATABASE_FILE } from '../db/index.js';
import { collectStorageAttribution, reclaimableBytes } from '../db/storageStats.js';
import {
  declaredRetentionCeilingLines,
  declaredEventRetentionCeilingHours,
  declaredClosedBufferCeilingDays,
  ceilingState,
} from '../services/retentionLimits.js';

const router = Router();

const CACHE_TTL_MS = 60 * 1000;
let cached: { at: number; payload: Record<string, unknown> } | null = null;
let building: Promise<Record<string, unknown>> | null = null;

function fileBytes(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

// Only derive a bytes/row ratio once there's enough data for the division to
// mean something — on a near-empty instance the fixed schema overhead would
// dominate and "20 KB per line" is a lie. Null = the client omits ≈ sizes.
const MIN_ROWS_FOR_RATIO = 10_000;

async function buildPayload(): Promise<Record<string, unknown>> {
  const { users, totalMessageRows } = await collectStorageAttribution();
  const dbBytes = fileBytes(DATABASE_FILE);
  const maxLines = declaredRetentionCeilingLines();
  const maxEventHours = declaredEventRetentionCeilingHours();
  const maxClosedBufferDays = declaredClosedBufferCeilingDays();
  return {
    generatedAt: new Date().toISOString(),
    // Derived from THIS instance's file and row count rather than a baked
    // constant, so schema drift and unusual content self-calibrate. Slightly
    // generous (the whole file, messages ≈ 95% of it) — the right direction
    // for a number an operator provisions disk from.
    approxBytesPerRow:
      totalMessageRows >= MIN_ROWS_FOR_RATIO ? Math.round(dbBytes / totalMessageRows) : null,
    database: {
      fileBytes: dbBytes,
      walBytes: fileBytes(`${DATABASE_FILE}-wal`),
      reclaimableBytes: reclaimableBytes(),
    },
    // States, not just values: `null` alone can't distinguish "unset" from
    // "declared but unparseable (fail-open)", and this pane is exactly where
    // an operator comes to check — see ceilingState.
    ceilings: {
      maxLines,
      maxLinesState: ceilingState('LURKER_MAX_RETENTION_LINES', maxLines),
      maxEventHours,
      maxEventHoursState: ceilingState('LURKER_MAX_EVENT_RETENTION_HOURS', maxEventHours),
      maxClosedBufferDays,
      maxClosedBufferDaysState: ceilingState('LURKER_MAX_CLOSED_BUFFER_DAYS', maxClosedBufferDays),
    },
    users,
  };
}

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  // Async work wrapped per the no-async-endpoint-handlers rule: the handler
  // itself stays sync, the IIFE forwards failures to next().
  void (async () => {
    try {
      const fresh = req.query.refresh === '1';
      if (!fresh && cached && Date.now() - cached.at <= CACHE_TTL_MS) {
        res.json(cached.payload);
        return;
      }
      // Single-flight: two admins (or a refresh spam) share one walk.
      if (!building) {
        building = buildPayload().finally(() => {
          building = null;
        });
      }
      const payload = await building;
      cached = { at: Date.now(), payload };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  })();
});

export default router;
