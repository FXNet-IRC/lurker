// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Process-level guards for a self-hosted instance that outlives its terminal
// (#442). `disown` only stops the shell's SIGHUP — the process keeps fds 1/2
// into the pty, and once the pty is torn down the NEXT stdout/stderr write
// fails; without an 'error' listener Node turns that into an uncaught
// exception and the first log line after the terminal vanishes kills the
// server.
//
// ⚠ This module is IMPORTED FOR ITS SIDE EFFECT as server.ts's FIRST import,
// ahead of 'dotenv/config' and everything that pulls in db/index.ts. Module
// evaluation follows import-declaration order, and the import phase itself
// writes to stdout on every boot (dotenv's injection banner, the boot
// migration's '[db] …' lines) — guards installed from server.ts's module BODY
// would arrive after the exact writes that crash a dead-pty boot. That is
// also why nothing here may import anything: a dependency would evaluate
// before dotenv populates the environment it reads.
//
// ALL 'error' events on the two streams are swallowed, not just EPIPE/EIO: a
// failed stdio write is never worth killing the server, and an allowlist
// merely converts the exotic variants (EBADF from an fd something closed)
// into a one-tick-delayed copy of the same crash via the fatal handler. The
// first suppression is surfaced through onStdioSuppressed so "console logging
// stopped" (e.g. the consumer of `npm start | tee` died) is a discoverable
// system-log line rather than a weeks-long mystery gap in the log file.

let suppressed: string | null = null;
let notify: ((detail: string) => void) | null = null;

export function suppressStdioStreamErrors(stream: Pick<NodeJS.WriteStream, 'on'>, name: string) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (suppressed != null) return;
    suppressed = `${name}: ${err?.code || err?.message || 'unknown stream error'}`;
    notify?.(suppressed);
  });
}

// server.ts registers the DB-backed breadcrumb here once its own imports are
// usable (the guards must exist long before systemLog can be). If a write
// already failed during the import phase, the notifier fires immediately.
export function onStdioSuppressed(fn: (detail: string) => void): void {
  notify = fn;
  if (suppressed != null) fn(suppressed);
}

function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try {
    return `non-Error thrown: ${JSON.stringify(err)}`;
  } catch {
    return `non-Error thrown: ${String(err)}`;
  }
}

/**
 * Fatal-exception exit with a durable record: an uncaught exception (or, under
 * Node's default mode, an unhandled rejection — `origin` says which) still
 * exits — a process in an unknown state must not limp on — but the reason is
 * recorded first, because the terminal that would have shown the stack may be
 * long gone. Ordering is load-bearing and pinned by tests: record first, a
 * failed record must not mask the exit, exit(1) last.
 */
export function installFatalExceptionExit(
  record: (text: string) => void,
  target: NodeJS.EventEmitter = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  target.on('uncaughtException', (err: unknown, origin: string) => {
    try {
      record(`fatal ${origin || 'uncaughtException'}: ${describeThrown(err)}`);
    } catch {
      /* the record failing must not mask the exit path */
    }
    try {
      console.error(`[lurker] fatal ${origin || 'uncaughtException'}:`, err);
    } catch {
      /* a dead stdio stream may be exactly why we're here */
    }
    exit(1);
  });
}

// Test seam: `suppressed`/`notify` are deliberately module-global (first
// failure wins, process-wide), which tests have to be able to unwind.
export function resetStdioSuppressionForTests(): void {
  suppressed = null;
  notify = null;
}

// The side effect this module exists for — see the header note on ordering.
suppressStdioStreamErrors(process.stdout, 'stdout');
suppressStdioStreamErrors(process.stderr, 'stderr');
