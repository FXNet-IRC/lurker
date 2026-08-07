// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';

// Idle-typing debounce before a buffer's draft is flushed to the server.
// Short enough that a typical pause between sentences is plenty to persist
// the line; long enough that a rapid burst of keystrokes coalesces into one
// write. Buffer switch, blur, and submit all force an immediate flush.
const FLUSH_DEBOUNCE_MS = 500;

function key(networkId: number | string, target: string) {
  return `${networkId}::${target}`;
}

// Debounce timers and the unflushed-pending tracker live module-local: they
// aren't reactive state, and keeping them out of Pinia means $reset doesn't
// have to handle non-serializable Map entries. `resetTimers()` clears them
// in concert with $reset on logout.
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key -> setTimeout id
const pending = new Map<string, { networkId: number | string; target: string }>(); // key -> { networkId, target }

// The buffer the composer is actively IME-composing into (compositionstart →
// compositionend), or null. Dropping v-model gave the composer live text
// during composition, but also dropped vModelText's beforeUpdate guard that
// deferred WRITES to a composing textarea — this flag re-establishes that
// protection at the store, where every dangerous write originates. While set,
// for that one buffer:
//   - remote updates and snapshot seeds are DROPPED: the in-flight composition
//     is by definition newer (last-write-wins), and the next local flush
//     overwrites the server copy anyway — while a write-through would repaint
//     the focused textarea under a live preedit and destroy the word;
//   - the debounce flush is DEFERRED, so a mid-word pause can't ship raw
//     phonetic preedit as the durable cross-device draft (and `pending` stays
//     armed for the whole composition instead of disarming at the 500ms mark).
// The pagehide beacon still ships the store as-is: a killed app keeps its
// draft, possibly with a trailing preedit — better than losing the line.
let composingKey: string | null = null;

// Mirrors the server's per-buffer drafts table. Server is the source of truth
// on snapshot (initial connect, visibility-resync). Local writes go in
// optimistically and flush on a debounce so the input bar doesn't feel
// rate-limited; `pending` records which buffers haven't been flushed yet so
// a snapshot echo or a remote-update fan-out won't clobber what the user is
// still typing.
export const useDraftStore = defineStore('drafts', {
  state: () => ({
    // `${networkId}::${target}` -> body string. Sparse: an empty/unused
    // buffer has no entry. Drives `hasDraft` for the pencil indicator.
    drafts: {} as Record<string, string>,
  }),
  getters: {
    forBuffer: (state) => (networkId: number | string, target: string) =>
      state.drafts[key(networkId, target)] || '',
    hasDraft: (state) => (networkId: number | string, target: string) => {
      const body = state.drafts[key(networkId, target)];
      return typeof body === 'string' && body.length > 0;
    },
  },
  actions: {
    // Apply a fresh server snapshot. Buffers with an un-flushed local edit
    // are preserved — last-write-wins should treat the still-pending edit as
    // newer than whatever the snapshot froze.
    seed(list: any[]) {
      const next: Record<string, string> = {};
      if (Array.isArray(list)) {
        for (const d of list) {
          if (!d) continue;
          const k = key(d.networkId, d.target);
          if (pending.has(k) || k === composingKey) {
            const existing = this.drafts[k];
            if (typeof existing === 'string' && existing.length > 0) next[k] = existing;
            continue;
          }
          if (typeof d.body === 'string' && d.body.length > 0) next[k] = d.body;
        }
      }
      // Bring along pending-only buffers the snapshot didn't include (typed
      // locally before this client ever flushed, so the server doesn't know
      // about them yet). The composing buffer rides along too: compositionstart
      // fires before the first input event, so there's a gap where it isn't
      // pending yet.
      for (const k of composingKey ? [...pending.keys(), composingKey] : pending.keys()) {
        if (next[k] != null) continue;
        const existing = this.drafts[k];
        if (typeof existing === 'string' && existing.length > 0) next[k] = existing;
      }
      this.drafts = next;
    },
    // Fan-out from another tab/device. Skip if we have a pending local edit —
    // our debounce will flush momentarily and last-write-wins picks the right
    // one by updated_at.
    applyRemoteUpdate(networkId: number | string, target: string, body: string) {
      const k = key(networkId, target);
      // The composing check is load-bearing on its own: `pending` disarms when
      // the debounced flush fires, which a >500ms mid-word pause used to allow —
      // leaving a remote update free to repaint the focused, composing textarea
      // through the :value binding and destroy the in-flight word.
      if (pending.has(k) || k === composingKey) return;
      const text = typeof body === 'string' ? body : '';
      if (text.length > 0) this.drafts[k] = text;
      else delete this.drafts[k];
    },
    // Local optimistic write — input bar binds through this. Schedules a
    // debounced WS push to the server.
    setLocal(networkId: number | string, target: string, body: string) {
      const k = key(networkId, target);
      const text = typeof body === 'string' ? body : '';
      if (text.length > 0) this.drafts[k] = text;
      else delete this.drafts[k];
      pending.set(k, { networkId, target });
      this.scheduleFlush(networkId, target);
    },
    // Force-flush a single buffer's pending write to the server immediately.
    // Called on buffer-switch, input blur, and right before clearing on send.
    flushBuffer(networkId: number | string, target: string) {
      const k = key(networkId, target);
      if (!pending.has(k)) return;
      this.sendForBuffer(networkId, target);
    },
    // Drop in-memory state for a closed buffer. The server-side row is also
    // cleared by wsHub's close-buffer handler, so no flush is needed.
    drop(networkId: number | string, target: string) {
      const k = key(networkId, target);
      delete this.drafts[k];
      this.clearTimer(k);
      pending.delete(k);
      if (composingKey === k) composingKey = null;
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts). rekey moves the body AND the
    // module-level debounce bookkeeping — a pending flush keyed by the dead
    // name would otherwise fire a draft-set for a buffer the server just
    // renamed away.
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      this.drop(networkId, target);
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = key(networkId, from);
      const toKey = key(networkId, to);
      // Destination wins on a merge collision: if the destination buffer has
      // ANY local draft state (body, pending flush, armed timer), the
      // source's is dropped rather than clobbering what the user typed there
      // — mirroring the server's merge (survivor's non-empty draft wins).
      const destHasState =
        this.drafts[toKey] != null || pending.has(toKey) || flushTimers.has(toKey);
      const fromTimer = flushTimers.get(fromKey);
      if (fromTimer) {
        // Never move the old timeout: its closure captured the OLD name.
        clearTimeout(fromTimer);
        flushTimers.delete(fromKey);
      }
      if (destHasState) {
        delete this.drafts[fromKey];
        pending.delete(fromKey);
        return;
      }
      if (this.drafts[fromKey] != null) {
        this.drafts[toKey] = this.drafts[fromKey];
        delete this.drafts[fromKey];
      }
      if (pending.has(fromKey)) {
        pending.delete(fromKey);
        pending.set(toKey, { networkId, target: to });
      }
      if (fromTimer) this.scheduleFlush(networkId, to);
    },
    // Beacon path used on tab close: ship every un-flushed buffer in one POST
    // since a WS send may already be in teardown. Returns whether anything
    // was actually queued — the sendBeacon return is best-effort either way.
    flushAllForBeacon() {
      if (!pending.size) return false;
      const drafts: { networkId: number | string; target: string; body: string }[] = [];
      for (const [k, ref] of pending) {
        const body = this.drafts[k] || '';
        drafts.push({ networkId: ref.networkId, target: ref.target, body });
        this.clearTimer(k);
      }
      pending.clear();
      try {
        // sendBeacon rejects application/json (CORS preflight is not allowed
        // on a beacon), so we ship a text/plain Blob carrying the JSON string
        // and the server JSON.parses it. Same-origin in production, so cookies
        // ride along normally.
        const blob = new Blob([JSON.stringify({ drafts })], { type: 'text/plain;charset=UTF-8' });
        return navigator.sendBeacon('/api/drafts/flush', blob);
      } catch (_) {
        return false;
      }
    },
    // Pinia's $reset wipes `drafts`, but the module-level timers/pending Maps
    // are out of band — useSessionReset calls this so they're cleared too.
    resetTimers() {
      for (const id of flushTimers.values()) clearTimeout(id);
      flushTimers.clear();
      pending.clear();
      composingKey = null;
    },
    // The composer's composition handlers. beginComposition marks the buffer;
    // endComposition clears WHICHEVER buffer was marked (buffer-switch and blur
    // call it too, so a missed compositionend can never suppress remote updates
    // forever) and arms the flush that scheduleFlush deferred meanwhile.
    beginComposition(networkId: number | string, target: string) {
      composingKey = key(networkId, target);
    },
    endComposition() {
      if (composingKey == null) return;
      const k = composingKey;
      composingKey = null;
      const ref = pending.get(k);
      if (ref) this.scheduleFlush(ref.networkId, ref.target);
    },
    scheduleFlush(networkId: number | string, target: string) {
      const k = key(networkId, target);
      this.clearTimer(k);
      // Deferred while this buffer is mid-composition: flushing now would ship
      // raw preedit as the durable cross-device draft AND disarm `pending`.
      // endComposition re-arms the flush; `pending` stays set meanwhile.
      if (k === composingKey) return;
      const id = setTimeout(() => {
        flushTimers.delete(k);
        this.sendForBuffer(networkId, target);
      }, FLUSH_DEBOUNCE_MS);
      flushTimers.set(k, id);
    },
    clearTimer(k: string) {
      const id = flushTimers.get(k);
      if (id) {
        clearTimeout(id);
        flushTimers.delete(k);
      }
    },
    sendForBuffer(networkId: number | string, target: string) {
      const k = key(networkId, target);
      pending.delete(k);
      this.clearTimer(k);
      const body = this.drafts[k] || '';
      if (body.length > 0) {
        socketSend({ type: 'draft-set', networkId, target, body });
      } else {
        socketSend({ type: 'draft-clear', networkId, target });
      }
    },
  },
});
