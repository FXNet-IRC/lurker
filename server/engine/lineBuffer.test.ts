// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { ByteBudget, LineBuffer } from './lineBuffer.js';

const seqs = (b: LineBuffer) => b.pending().map((l) => l.seq);

describe('LineBuffer', () => {
  it('numbers lines from 1 and keeps them until acked', () => {
    const b = new LineBuffer(1024 * 1024, new ByteBudget(1024 * 1024));
    expect(b.push('a')).toBe(1);
    expect(b.push('b')).toBe(2);
    expect(b.push('c')).toBe(3);
    expect(seqs(b)).toEqual([1, 2, 3]);
    b.ack(2);
    expect(seqs(b)).toEqual([3]);
    // An ack below what is already gone is a no-op, not an error.
    b.ack(1);
    expect(seqs(b)).toEqual([3]);
    b.ack(3);
    expect(b.length).toBe(0);
    expect(b.lastSeq).toBe(3);
    expect(b.takeGap()).toBeNull();
  });

  it('drops the OLDEST lines past its byte cap and records one gap', () => {
    // Each line is 10 bytes + CRLF = 12; cap fits four.
    const b = new LineBuffer(48, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 6; i++) b.push('x'.repeat(10));
    expect(seqs(b)).toEqual([3, 4, 5, 6]);
    expect(b.bytes).toBe(48);
    const gap = b.takeGap();
    expect(gap).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 2 });
    // Reported once.
    expect(b.takeGap()).toBeNull();
  });

  it('never drops the newest line, even when it alone exceeds the cap', () => {
    const b = new LineBuffer(16, new ByteBudget(1024 * 1024));
    b.push('short');
    b.push('a'.repeat(100));
    expect(seqs(b)).toEqual([2]);
  });

  it('sheds from the LARGEST buffer when the process-wide budget is full', () => {
    const budget = new ByteBudget(60);
    const hoarder = new LineBuffer(1024, budget);
    const quiet = new LineBuffer(1024, budget);
    for (let i = 0; i < 4; i++) hoarder.push('x'.repeat(10)); // 48 bytes
    quiet.push('y'.repeat(10)); // 60: exactly full
    quiet.push('y'.repeat(10)); // 72: over — the hoarder pays, not the pusher
    expect(quiet.length).toBe(2);
    expect(hoarder.length).toBe(3);
    expect(hoarder.takeGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 1 });
    expect(quiet.takeGap()).toBeNull();
    expect(budget.used).toBe(60);
    hoarder.dispose();
    expect(budget.used).toBe(24);
    // A disposed buffer is out of the running.
    for (let i = 0; i < 4; i++) quiet.push('z'.repeat(10));
    expect(quiet.length).toBe(5);
    expect(budget.used).toBe(60);
  });

  it('shrinks a recorded gap as acks land inside it', () => {
    const b = new LineBuffer(48, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 8; i++) b.push('x'.repeat(10)); // keeps 5..8, dropped 1..4
    expect(b.peekGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 4 });
    b.ack(2); // the app had 1..2 after all
    expect(b.peekGap()).toMatchObject({ firstDroppedSeq: 3, lastDroppedSeq: 4 });
    b.ack(4); // and the rest
    expect(b.peekGap()).toBeNull();
    expect(b.length).toBe(4);
  });

  it('extends an open gap rather than opening a second one', () => {
    const b = new LineBuffer(24, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 4; i++) b.push('x'.repeat(10));
    expect(b.takeGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 2 });
    b.push('x'.repeat(10));
    b.push('x'.repeat(10));
    expect(b.takeGap()).toMatchObject({ firstDroppedSeq: 3, lastDroppedSeq: 4 });
  });
});
