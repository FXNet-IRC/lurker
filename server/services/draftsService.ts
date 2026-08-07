// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { upsertDraft, clearDraft, listForUser } from '../db/drafts.js';

// Per-buffer drafts are last-write-wins by updated_at — no merging, no CRDT.
// The conflict surface is tiny in practice (you don't actively type into the
// same buffer on two devices simultaneously), so this service just upserts and
// emits a `change` for wsHub to fan out to every other tab of the same user.
//
// Empty bodies are treated as a delete: the row is sparse on disk, and clients
// expect "no draft" rather than "draft with empty string" so the pencil chip
// can drive itself off `hasDraft` without extra trim checks.
class DraftsService extends EventEmitter {
  set(
    userId: number,
    networkId: number,
    target: string,
    body: unknown,
    originWs: unknown = null,
  ): void {
    const text = typeof body === 'string' ? body : '';
    if (text.length === 0) {
      this.clear(userId, networkId, target, originWs);
      return;
    }
    const bufferId = upsertDraft(userId, networkId, target, text);
    if (bufferId === undefined) return; // unknown buffer — nothing stored, nothing to announce
    this.emit('change', { userId, networkId, target, bufferId, body: text, originWs });
  }

  clear(userId: number, networkId: number, target: string, originWs: unknown = null): void {
    const bufferId = clearDraft(userId, networkId, target);
    if (bufferId === undefined) return;
    this.emit('change', { userId, networkId, target, bufferId, body: '', originWs });
  }

  snapshotForUser(userId: number): unknown[] {
    return listForUser(userId);
  }
}

const draftsService = new DraftsService();
export default draftsService;
