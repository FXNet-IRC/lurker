// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Bytes accumulating on disk on their way somewhere else.
//
// ⚠ Its own module because BOTH backends need it and it belongs to neither. The
// filesystem backend publishes a temp file by renaming it into place; the bucket
// backend hashes one and streams it to a PUT. Leaving it in `local.ts` meant the
// bucket backend importing the filesystem backend, which reads as a layering
// mistake even though the code was right.
//
// ⚠⚠ STREAMED, never buffered — this is the whole reason it exists. Collecting an
// object in memory cost a full copy in `chunks` plus a second at `Buffer.concat`,
// and the per-request 8 MB image ceiling multiplied by `mediaPool`'s 24 slots:
// ~192 MB steady state and ~384 MB transient, memory the uncached path never
// allocated at all, reachable by anyone authenticated opening 24 concurrent large
// images. `s3` has it worse still, because the route does not await a store — so a
// buffer there outlives the pool slot that bounded it and nothing caps how many
// accumulate.

import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';

/**
 * One staged write.
 *
 * Both backends face the same problem — chunks arrive from a stream, the
 * destination is not a heap buffer — and only the publish step differs: `local`
 * renames, `s3` uploads and unlinks.
 */
export interface TempFile {
  path: string;
  write(chunk: Buffer): void;
  /** Close, and report whether the bytes are intact. The file is the caller's to
   *  move or delete afterwards; a `false` has already cleaned up. */
  close(): Promise<boolean>;
  /** Close and delete, whatever state it is in. Safe to call twice. */
  discard(): Promise<void>;
}

export async function openTempFile(dir: string, name: string): Promise<TempFile | null> {
  // ⚠⚠ RANDOM, not pid+timestamp. Nothing dedupes the byte path — `mediaPool`
  // bounds concurrency, not identity — so several writes of the SAME key can be in
  // flight at once. Two in the same millisecond shared a temp path, and a write
  // truncates only at open: the shorter one left the longer body's tail in place
  // and published a file matching NEITHER, under a row recording the shorter
  // length. Reproduced with 4 MB and 1 MB bodies while this was pid+timestamp.
  const tmp = path.join(dir, `${name}.${crypto.randomUUID()}.tmp`);
  let handle: fsSync.WriteStream;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = fsSync.createWriteStream(tmp);
  } catch {
    return null;
  }
  // A write error (ENOSPC, EROFS) must not become an unhandled 'error' event and
  // take the process down; it is recorded and turns commit into a no-op.
  let broken = false;
  handle.on('error', () => {
    broken = true;
  });

  let done = false;
  /**
   * ⚠⚠ Waits on `close`, NOT on `end`'s callback.
   *
   * `writable.end(cb)` attaches its callback to `finish`, which a stream that
   * ERRORS never reaches — node's own docs say the callback "may or may not" be
   * called on error. So on ENOSPC or EROFS, which is precisely the state a cache
   * ceiling exists for, the promise never settled: `commit()` and `abort()` hung
   * forever, the descriptor and the temp file stayed stranded, and the store
   * decision was never reached. `close` fires on both paths.
   *
   * ⚠ The already-closed check is not belt-and-braces. A stream destroyed by an
   * earlier error has emitted `close` before we ever get here, and a listener
   * added afterwards waits for an event that has been and gone.
   */
  const closeStream = () =>
    new Promise<void>((resolve) => {
      if (handle.closed || handle.destroyed) {
        resolve();
        return;
      }
      handle.once('close', () => resolve());
      handle.end();
    });

  return {
    path: tmp,
    write(chunk: Buffer): void {
      if (done || broken) return;
      // Backpressure is deliberately not awaited: the response is already being
      // piped to the reader and must not wait on our disk. The stream's own buffer
      // bounds this at the transfer's cap, which is what the memory fix is about.
      handle.write(chunk);
    },
    async close(): Promise<boolean> {
      if (done) return false;
      done = true;
      await closeStream();
      if (broken) {
        await fs.unlink(tmp).catch(() => {});
        return false;
      }
      return true;
    },
    async discard(): Promise<void> {
      if (!done) {
        done = true;
        await closeStream();
      }
      // ⚠ The temp file is OURS. Left behind it is invisible to the index and
      // therefore to eviction — bytes on the volume nothing counts and nothing can
      // reclaim.
      await fs.unlink(tmp).catch(() => {});
    },
  };
}
