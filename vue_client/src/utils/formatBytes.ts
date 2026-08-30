// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * Human-readable byte size, four tiers (B / KB / MB / GB). Hoisted so screens
 * stop growing private copies — DataPane, TransfersModal, and
 * RecentUploadsModal each carry one today, and they have already drifted
 * (one caps at MB, one guards zero differently); migrate them here as
 * they're next touched.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
