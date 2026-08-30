// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { FrameReader, MAX_FRAME_BYTES, encodeFrame, parseHostPort } from './protocol.js';

describe('FrameReader', () => {
  it('reassembles frames split across chunks and ignores blank lines', () => {
    const r = new FrameReader();
    const a = encodeFrame({ op: 'list' });
    const b = encodeFrame({ op: 'ack', id: 'x', seq: 4 });
    const all = a + '\n' + b;
    const mid = Math.floor(all.length / 2);
    expect(r.push(all.slice(0, mid))).toEqual([{ op: 'list' }]);
    expect(r.push(all.slice(mid))).toEqual([{ op: 'ack', id: 'x', seq: 4 }]);
  });

  it('refuses a frame without an op', () => {
    const r = new FrameReader();
    expect(() => r.push('{"nope":1}\n')).toThrow(/malformed/);
  });

  it('refuses an over-long line before it is complete', () => {
    const r = new FrameReader();
    expect(() => r.push('{"op":"' + 'x'.repeat(MAX_FRAME_BYTES))).toThrow(/too long/);
  });
});

describe('parseHostPort', () => {
  const d = { host: '0.0.0.0', port: 8016 };
  it('handles every accepted shape', () => {
    expect(parseHostPort('', d)).toEqual(d);
    expect(parseHostPort('9000', d)).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(parseHostPort('127.0.0.1:9000', d)).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(parseHostPort('engine', d)).toEqual({ host: 'engine', port: 8016 });
    expect(parseHostPort('[::1]:9000', d)).toEqual({ host: '::1', port: 9000 });
    expect(parseHostPort('[::1]', d)).toEqual({ host: '::1', port: 8016 });
  });
  it('rejects a bad port in every shape that names one', () => {
    expect(() => parseHostPort('host:70000', d)).toThrow(/invalid port/);
    expect(() => parseHostPort('host:abc', d)).toThrow(/invalid port/);
    // The bare-port and [v6]:port forms validate too — deferring these to
    // listen()/connect() turns a typo into an opaque ERR_SOCKET_BAD_PORT.
    expect(() => parseHostPort('70000', d)).toThrow(/invalid port/);
    expect(() => parseHostPort('0', d)).toThrow(/invalid port/);
    expect(() => parseHostPort('[::1]:70000', d)).toThrow(/invalid port/);
    expect(() => parseHostPort('[::1]:0', d)).toThrow(/invalid port/);
  });
});
