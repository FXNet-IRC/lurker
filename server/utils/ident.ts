// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Derives the IRC ident (the user part of nick!ident@host) that the built-in
// identd reports for a connection.
//
//   node edition — the ident must identify the GLOBAL account, so it's stable
//     across cell moves and unique fleet-wide. Cells are provisioned with the
//     account username `acct-<controlPlaneAccountId>`, so we surface
//     `lu<controlPlaneAccountId>` ("lu" = Lurker user, so a network operator can
//     tell at a glance it's one of ours). Using the cell-local user id would
//     change if an account were ever migrated to another cell.
//   standalone — the operator's per-network choice wins (the configured
//     username, else the nick), matching how a single-user bouncer behaves.

const NON_IDENT_CHARS = /[^A-Za-z0-9._-]/g;

function sanitizeIdent(value: string): string {
  return value.replace(NON_IDENT_CHARS, '').slice(0, 16);
}

/**
 * A stable, unique, ident-safe token for a locked (FXNet) account, keyed on the
 * immutable local user id — `lu<id>`. A user can't change it (nick/username
 * edits don't affect it), so a network oper can ban exactly one locked user via
 * `*!lu<id>@<lurker-host>` without catching every other lurker user that shares
 * the server's IP. Mirrors node edition's per-account ident for the same reason.
 */
export function lockedAccountIdent(userId: number): string {
  return sanitizeIdent(`lu${userId}`);
}

export function deriveIdent(opts: {
  nodeMode: boolean;
  accountUsername: string;
  networkUsername: string | null;
  nick: string;
  networkLocked?: boolean;
  userId?: number;
}): string {
  if (opts.nodeMode) {
    const m = /^acct-(\d+)$/.exec(opts.accountUsername.trim());
    if (m) return sanitizeIdent(`lu${m[1]}`);
    // Fallback (e.g. the operator's own admin account on a cell): stay stable +
    // ident-safe rather than inventing an id.
    return sanitizeIdent(opts.accountUsername) || 'user';
  }
  // FXNet network lock: bind the ident to the account so single-user bans are
  // reliable and can't be spoofed by editing the network username or nick.
  if (opts.networkLocked && opts.userId != null) {
    return lockedAccountIdent(opts.userId);
  }
  return sanitizeIdent(opts.networkUsername || opts.nick) || 'user';
}
