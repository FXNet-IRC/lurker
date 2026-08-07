// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  suppressStdioStreamErrors,
  onStdioSuppressed,
  installFatalExceptionExit,
  resetStdioSuppressionForTests,
} from './processGuards.js';

// These suites prove the module's own decision logic (swallow-everything, the
// one-time notifier, the fatal-exit ordering) against injected fakes. What
// they deliberately cannot prove is the INSTALL ORDER on the real process —
// that the side-effect import in server.ts really precedes dotenv's banner
// and the boot migration's writes — which lives in import-declaration order
// and is documented in both files.

function errWithCode(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(code);
  e.code = code;
  return e;
}

function fakeStream() {
  return new EventEmitter() as unknown as Pick<NodeJS.WriteStream, 'on'> & EventEmitter;
}

beforeEach(() => {
  resetStdioSuppressionForTests();
});

describe('suppressStdioStreamErrors', () => {
  it('swallows every stream error, not an allowlist — EBADF would otherwise rethrow into the fatal handler', () => {
    const stream = fakeStream();
    suppressStdioStreamErrors(stream, 'stdout');
    for (const code of ['EPIPE', 'EIO', 'EBADF', 'ENOSPC']) {
      expect(() => stream.emit('error', errWithCode(code))).not.toThrow();
    }
    expect(() => stream.emit('error', new Error('no code at all'))).not.toThrow();
  });

  it('reports only the FIRST suppression to the notifier', () => {
    const stream = fakeStream();
    suppressStdioStreamErrors(stream, 'stdout');
    const seen: string[] = [];
    onStdioSuppressed((d) => seen.push(d));
    stream.emit('error', errWithCode('EPIPE'));
    stream.emit('error', errWithCode('EIO'));
    expect(seen).toEqual(['stdout: EPIPE']);
  });

  it('fires a late-registered notifier immediately — an import-phase failure must not be lost', () => {
    const stream = fakeStream();
    suppressStdioStreamErrors(stream, 'stderr');
    stream.emit('error', errWithCode('EIO'));
    const seen: string[] = [];
    onStdioSuppressed((d) => seen.push(d));
    expect(seen).toEqual(['stderr: EIO']);
  });
});

describe('installFatalExceptionExit', () => {
  it('records first (with origin), then exits 1', () => {
    const target = new EventEmitter();
    const order: string[] = [];
    installFatalExceptionExit(
      (text) => order.push(`record:${text}`),
      target,
      (code) => order.push(`exit:${code}`),
    );
    target.emit('uncaughtException', new Error('boom'), 'uncaughtException');
    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^record:fatal uncaughtException: Error: boom/);
    expect(order[1]).toBe('exit:1');
  });

  it('still exits when the record itself throws', () => {
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    installFatalExceptionExit(
      () => {
        throw new Error('db is gone too');
      },
      target,
      exit,
    );
    target.emit('uncaughtException', new Error('boom'), 'uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('names an unhandled rejection as such and survives a non-Error reason', () => {
    // Under Node's default --unhandled-rejections=throw, rejections land here
    // with origin 'unhandledRejection' — and reject('nope') has no stack, so
    // the record must say what kind of value arrived rather than logging a
    // bare, hint-free string.
    const target = new EventEmitter();
    const records: string[] = [];
    installFatalExceptionExit(
      (t) => records.push(t),
      target,
      () => {},
    );
    target.emit('uncaughtException', 'nope', 'unhandledRejection');
    expect(records[0]).toBe('fatal unhandledRejection: non-Error thrown: "nope"');
  });
});
