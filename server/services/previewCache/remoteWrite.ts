// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The staged-write scaffold every remote backend shares. Two invariants live in
// it, and they are the reason it is ONE function rather than a per-backend
// copy: the staging file is unlinked on EVERY commit exit (nothing else — not
// the index, not eviction — knows it exists, so a leak is bytes no later pass
// can find), and the in-flight slot is settled exactly once on every path.
// A fix to either must reach every backend at the same moment.

import fs from 'fs/promises';
import { openTempFile } from './tempFile.js';
import { tryAcquireStoreSlot, warnOnce } from './inflight.js';

/** A store in progress. The one writer shape every backend adapts to; `commit`
 *  needs the content type because remote backends put it ON the object. */
export interface RemoteWriter {
  write(chunk: Buffer): void;
  commit(contentType: string): Promise<boolean>;
  abort(): Promise<void>;
}

/**
 * Begin storing an object whose bytes are still arriving.
 *
 * ⚠⚠ STAGED TO A FILE, never collected in memory — the backends need the full
 * payload before they can send (SigV4 hashes it; multipart declares an exact
 * Content-Length), and the route streams it in chunk by chunk. Collecting it in
 * the heap would cost the 8 MB per-request image ceiling times `mediaPool`'s 24
 * slots, and worse: the route deliberately does not await a store, so a buffer
 * outlives the pool slot that bounded it and nothing caps how many accumulate.
 *
 * ⚠⚠ ITS OWN BOUND (the shared slot ceiling), because `mediaPool`'s does not
 * reach this far. The route calls `commit` without awaiting it and hands its
 * pool slot back on the response's `close` at the same moment, so `send` runs
 * entirely OUTSIDE the 24 slots for up to its transport timeout, each call
 * pinning a staged file and an outbound socket.
 *
 * `send` is the ONLY per-backend part: given the staged file and its size, ship
 * the bytes and answer whether the remote accepted them (doing its own
 * `warnOnce` for a refusal it can describe better than we can).
 */
export async function openStagedRemoteWrite(
  stagingDir: string,
  key: string,
  label: string,
  send: (stagedPath: string, size: number, contentType: string) => Promise<boolean>,
): Promise<RemoteWriter | null> {
  // ⚠ Acquired BEFORE the staging file is opened, so the ceiling can never be
  // overshot by concurrent opens — and released if staging fails.
  const settle = tryAcquireStoreSlot();
  if (!settle) return null;

  const staged = await openTempFile(stagingDir, key);
  if (!staged) {
    settle();
    return null;
  }

  return {
    write(chunk: Buffer): void {
      staged.write(chunk);
    },
    async commit(contentType: string): Promise<boolean> {
      if (!(await staged.close())) {
        settle();
        return false;
      }
      try {
        const { size } = await fs.stat(staged.path);
        return await send(staged.path, size, contentType);
      } catch (err) {
        warnOnce(`${label} store failed: ${(err as Error)?.message ?? err}`);
        return false;
      } finally {
        // ⚠ ALWAYS, on every exit. The staging file is ours and nothing else knows
        // it exists — not the index, not eviction — so a leak here is bytes on the
        // volume that no later pass can find.
        await fs.unlink(staged.path).catch(() => {});
        settle();
      }
    },
    async abort(): Promise<void> {
      await staged.discard();
      settle();
    },
  };
}
