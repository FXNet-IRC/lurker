// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC CHAT session engine (#270 phase 2). A DCC CHAT is a direct, line-oriented
// TCP conversation between two clients — no server relays it. This wraps one
// socket as a chat: inbound bytes are split into CRLF-delimited lines and handed
// up as messages; outbound text is framed with CRLF. The caller owns the socket
// (from a listener we opened for an offer, or a dial-out to accept a peer's
// offer or answer a passive one) and the buffer/persistence — this is IRC-free
// and DB-free, exactly like dccReceiver/dccSender.
//
// A malicious peer could stream bytes without a newline forever. irssi's answer
// (line-split.c:23-32, whose comment cites DCC CHAT abuse by name) is to FORCE
// A SPLIT at the cap rather than buffer without bound — the peer gets its text
// delivered as several lines instead of the session dying, and the heap stays
// bounded either way. We do the same. HexChat's alternative — truncate at 2047
// and silently drop the rest (dcc.h:102, dcc.c:625-626) — loses data with no
// signal, so it is deliberately NOT copied.
//
// ⚠ The cap counts UTF-16 code units, not bytes: the socket is in utf8 mode, so
// `data` arrives already decoded (which is what we want — Node reassembles a
// multi-byte sequence split across two TCP segments, and substitutes U+FFFD for
// invalid input rather than dropping the line). One astral character therefore
// counts as two. The cap is a memory bound, not a protocol limit, so that's fine
// — it just must not be called "bytes".

import net from 'net';

// Chosen to match irssi's MAX_CHARS_IN_LINE (line-split.c:32).
const MAX_LINE_CHARS = 64 * 1024;

export interface DccChatOptions {
  /** A socket already connected to the peer (active offer we listened for, or a
   *  dial-out). When absent, `start()` dials host:port. */
  socket?: net.Socket;
  /** Dial target when `socket` is not provided (accepting a peer's active offer,
   *  or answering our passive offer's reverse reply). */
  host?: string;
  port?: number;
  /** A received line of chat text (already CRLF-stripped). */
  onLine?: (text: string) => void;
  /** The peer connected (only meaningful for the dial-out path). */
  onConnect?: () => void;
  /** The session ended cleanly (peer closed, or we did). */
  onClose?: () => void;
  /** The session failed (connect error, socket error, line-length abuse). */
  onError?: (err: Error) => void;
}

export class DccChat {
  private socket: net.Socket | null = null;
  private buf = '';
  private closed = false;

  constructor(private readonly opts: DccChatOptions) {}

  start(): void {
    const provided = this.opts.socket ?? null;
    const sock =
      provided ?? net.connect({ host: this.opts.host as string, port: this.opts.port as number });
    this.socket = sock;

    const wire = (): void => {
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => this.onData(chunk));
      sock.on('error', (e) => this.fail(e));
      sock.on('close', () => this.end());
    };

    if (provided) {
      wire();
    } else {
      sock.on('connect', () => {
        this.opts.onConnect?.();
        wire();
      });
      sock.on('error', (e) => this.fail(e));
    }
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buf += chunk;
    let nl: number;
    while (!this.closed) {
      nl = this.buf.indexOf('\n');
      if (nl === -1) {
        // No terminator yet. Hold the partial line unless it has outgrown the
        // cap, in which case force a split here (see the header note).
        if (this.buf.length <= MAX_LINE_CHARS) break;
        this.opts.onLine?.(this.buf.slice(0, MAX_LINE_CHARS));
        this.buf = this.buf.slice(MAX_LINE_CHARS);
        continue;
      }
      // Accept bare LF as well as CRLF: irssi, HexChat and repartee all SEND
      // bare LF, while WeeChat, HexDroid and znc send CRLF.
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.opts.onLine?.(line);
    }
  }

  /** Send one line of chat text (CRLF is appended; embedded CR/LF is stripped so
   *  a single message can't inject extra lines). Returns false if the session is
   *  already closed. */
  send(text: string): boolean {
    if (this.closed || !this.socket) return false;
    const clean = text.replace(/[\r\n]/g, ' ').slice(0, MAX_LINE_CHARS);
    try {
      this.socket.write(clean + '\r\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Close the session gracefully. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.end();
    } catch {
      /* already gone */
    }
    this.opts.onClose?.();
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose?.();
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      /* already gone */
    }
    this.opts.onError?.(err);
  }
}
