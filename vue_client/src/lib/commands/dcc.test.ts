// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseDccCommand } from './dcc.js';

describe('parseDccCommand', () => {
  it('treats no args as list', () => {
    expect(parseDccCommand('')).toEqual({ kind: 'list' });
    expect(parseDccCommand('   ')).toEqual({ kind: 'list' });
  });

  it('parses explicit list (and ls alias)', () => {
    expect(parseDccCommand('list')).toEqual({ kind: 'list' });
    expect(parseDccCommand('ls')).toEqual({ kind: 'list' });
  });

  it('parses accept/reject/cancel with an id', () => {
    expect(parseDccCommand('accept 7')).toEqual({ kind: 'accept', id: 7 });
    expect(parseDccCommand('reject 12')).toEqual({ kind: 'reject', id: 12 });
    expect(parseDccCommand('cancel 3')).toEqual({ kind: 'cancel', id: 3 });
  });

  it('accepts subcommand aliases', () => {
    expect(parseDccCommand('ok 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('yes 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('get 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('deny 1')).toEqual({ kind: 'reject', id: 1 });
    expect(parseDccCommand('no 1')).toEqual({ kind: 'reject', id: 1 });
    expect(parseDccCommand('abort 1')).toEqual({ kind: 'cancel', id: 1 });
    expect(parseDccCommand('stop 1')).toEqual({ kind: 'cancel', id: 1 });
  });

  it('is case-insensitive on the verb', () => {
    expect(parseDccCommand('ACCEPT 5')).toEqual({ kind: 'accept', id: 5 });
  });

  it('ignores trailing tokens after the id', () => {
    expect(parseDccCommand('accept 9 please')).toEqual({ kind: 'accept', id: 9 });
  });

  it('errors when an action is missing its id', () => {
    expect(parseDccCommand('accept')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('cancel')).toMatchObject({ kind: 'error' });
  });

  it('errors on a non-numeric or non-positive id', () => {
    expect(parseDccCommand('accept abc')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('reject 0')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('cancel -2')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('accept 1.5')).toMatchObject({ kind: 'error' });
  });

  it('errors on an unknown subcommand', () => {
    expect(parseDccCommand('frobnicate 1').kind).toBe('error');
  });

  it('parses /dcc chat <nick>', () => {
    expect(parseDccCommand('chat alice')).toEqual({ kind: 'chat', nick: 'alice', passive: false });
    expect(parseDccCommand('CHAT Bob')).toEqual({ kind: 'chat', nick: 'Bob', passive: false });
    expect(parseDccCommand('chat')).toMatchObject({ kind: 'error' });
  });

  // Opt-in, never a fallback: WeeChat and HexDroid mishandle a passive offer
  // into a silent dial to port 0, so the user has to ask for it by name.
  it('parses the -passive flag, in either position', () => {
    expect(parseDccCommand('chat -passive alice')).toEqual({
      kind: 'chat',
      nick: 'alice',
      passive: true,
    });
    expect(parseDccCommand('chat alice -passive')).toEqual({
      kind: 'chat',
      nick: 'alice',
      passive: true,
    });
  });

  it('rejects an unknown option rather than reading it as a nick', () => {
    const r = parseDccCommand('chat -active alice');
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/-active/);
  });

  // The chat verbs follow irssi exactly. The two non-irssi spellings that
  // existed briefly are gone, and must not quietly do something else instead.
  it('no longer accepts the non-irssi /dcc close <nick> shorthand', () => {
    expect(parseDccCommand('close bob')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('close')).toMatchObject({ kind: 'error' });
  });

  // ⚠ Read literally, `/dcc chat close bob` would OFFER a chat to a peer named
  // "close" — worse than an error. Point at the real spelling instead.
  it('catches /dcc chat close <nick> rather than offering a chat to "close"', () => {
    const r = parseDccCommand('chat close alice');
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/\/dcc close chat <nick>/);
  });

  it('still offers a chat to a peer who is genuinely nicked "close"', () => {
    expect(parseDccCommand('chat close')).toEqual({ kind: 'chat', nick: 'close', passive: false });
  });

  // ⚠⚠ QA: `/dcc close chat ami|shellter` answered "no live DCC chat" and left
  // the chat open, because the word after `close` was read as the nick — it
  // tried to close a chat with a peer called "chat". Type-first is irssi's
  // syntax (DCC CLOSE <type> <nick>, dcc.c:490), so it's the form people type.
  it("parses irssi's /dcc close <type> <nick>", () => {
    expect(parseDccCommand('close chat ami|shellter')).toEqual({
      kind: 'chatClose',
      nick: 'ami|shellter',
    });
    expect(parseDccCommand('close CHAT bob')).toEqual({ kind: 'chatClose', nick: 'bob' });
  });

  it('asks for a nick rather than closing a peer literally named "chat"', () => {
    expect(parseDccCommand('close chat')).toMatchObject({ kind: 'error' });
    // Someone genuinely nicked "chat" is still reachable, as in irssi.
    expect(parseDccCommand('close chat chat')).toEqual({ kind: 'chatClose', nick: 'chat' });
  });

  it("points irssi's file-transfer types at the id-based commands", () => {
    expect(parseDccCommand('close get bob')).toMatchObject({ kind: 'error' });
    const r = parseDccCommand('close send bob');
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/\/dcc cancel <id>/);
  });

  it('rejects trailing junk instead of guessing', () => {
    expect(parseDccCommand('close chat bob extra')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('chat bob extra')).toMatchObject({ kind: 'error' });
  });

  // `=bob` is the BUFFER; the peer is `bob`. Opening a chat with a peer
  // literally named "=bob" is never what was meant.
  it('refuses a =-prefixed nick', () => {
    expect(parseDccCommand('chat =bob')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('close =bob')).toMatchObject({ kind: 'error' });
  });

  // Copilot review on #973: `/dcc chat #room` would broadcast the offer to the
  // whole channel. All four sigils.
  it.each(['#room', '&local', '+nomodes', '!safe'])('refuses a channel: %s', (target) => {
    expect(parseDccCommand(`chat ${target}`)).toMatchObject({ kind: 'error' });
  });
});
