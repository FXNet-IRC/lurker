// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Whether sending should re-pin the message list to the bottom (#628).
//
// The default is yes, and always was: you send, you see your line land. But a
// reader working back through a busy channel loses their place every time they
// reply, so chat.keep_position_on_send lets them stay put — the send still goes
// out, it just doesn't drag the viewport with it. Nothing is lost by staying:
// the status bar's "Return (N new) ↓" counts the echo like any other arrival.
//
// Detached buffers (a #42 jump into history) re-pin no matter what the setting
// says. Live events are held out of the slice while detached, so the sent
// message isn't loaded at all — honouring "keep my position" there would leave
// the user staring at a stretch of history their message can never appear in,
// which reads as a failed send rather than a respected preference. The caller
// pairs this with a reattachToLive for the same reason: the scroll alone would
// only reach the end of the slice, and the message isn't there either.
export function shouldRepinOnSend(opts: { keepPosition: boolean; detached: boolean }): boolean {
  return !opts.keepPosition || opts.detached;
}
