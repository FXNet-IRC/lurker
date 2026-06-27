// Copyright (c) 2026 FXNet
// SPDX-License-Identifier: MPL-2.0

// Periodically delete idle guest accounts created by the public webchat. A guest
// (users.is_guest=1) is reaped once it has had no activity for the configured
// idle window AND has no live WebSocket — so an open-but-quiet tab is never
// reaped out from under the user. Deleting the row cascades to its networks,
// channels, messages, settings and sessions (FK ON DELETE CASCADE); we dispose
// the IRC connections first so no in-flight write hits a now-deleted network id.
//
// Only started when LURKER_PUBLIC_MODE is enabled (see server.ts). No-op
// otherwise — a non-public instance has no guests.

import { listIdleGuestIds, deleteUser } from '../db/users.js';
import { isUserConnected } from './wsHub.js';
import ircManager from './ircManager.js';
import { guestIdleMinutes } from '../utils/publicMode.js';
import * as systemLog from './systemLog.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function reapIdleGuestsOnce(): number {
  let reaped = 0;
  for (const id of listIdleGuestIds(guestIdleMinutes())) {
    // Race guard: never reap a guest who still has an open socket, even if their
    // last_seen_at is stale (a long-quiet tab). They'll be caught a later sweep
    // once the socket closes.
    if (isUserConnected(id)) continue;
    try {
      ircManager.disposeUser(id, 'guest idle');
      deleteUser(id);
      reaped += 1;
    } catch (err) {
      systemLog.log({
        scope: 'server',
        level: 'warn',
        text: `Failed to reap idle guest ${id}: ${(err as Error).message}`,
      });
    }
  }
  if (reaped > 0) {
    systemLog.log({ scope: 'server', text: `Reaped ${reaped} idle guest account(s)` });
  }
  return reaped;
}

export function startGuestReaper(): void {
  if (timer) return;
  timer = setInterval(reapIdleGuestsOnce, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopGuestReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
