// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { bufferPeer } from './ping.js';

describe('bufferPeer', () => {
  it('is the peer of a DM', () => {
    expect(bufferPeer('bob')).toBe('bob');
  });

  // ⚠⚠ The default used to be the buffer name, which put `PRIVMSG =bob` on the wire.
  it('is the peer of a DCC chat, not the =nick buffer', () => {
    expect(bufferPeer('=bob')).toBe('bob');
    expect(bufferPeer('=')).toBe('');
  });

  it('names nobody in a channel — all four sigils — or a pseudo-buffer', () => {
    for (const t of ['#chan', '&local', '+modeless', '!safe', ':server:1', ':system:', '', null]) {
      expect(bufferPeer(t)).toBe('');
    }
  });
});
