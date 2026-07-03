// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import webpush from 'web-push';
import type { PushSubscription } from '../db/pushSubscriptions.js';
import {
  listEnabledForUser,
  hasEnabledForUser,
  deleteById,
  touchSubscription,
  getMeta,
  setMeta,
} from '../db/pushSubscriptions.js';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:lurker@localhost';

let vapidConfigured = false;
let publicKey: string | null = null;
let privateKey: string | null = null;

function ensureVapid(): void {
  if (vapidConfigured) return;
  publicKey = getMeta('vapid_public');
  privateKey = getMeta('vapid_private');
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    setMeta('vapid_public', publicKey);
    setMeta('vapid_private', privateKey);
    console.log('[push] generated new VAPID keypair');
  }
  webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
  vapidConfigured = true;
}

export function getPublicKey(): string | null {
  ensureVapid();
  return publicKey;
}

// True if the user has at least one enabled push subscription. Lets callers
// skip building a push payload (e.g. computing the app-icon badge total) when
// deliver() would no-op on an empty subscription set anyway.
export function hasSubscriptions(userId: number): boolean {
  return hasEnabledForUser(userId);
}

export async function deliver(
  userId: number,
  payload: unknown,
): Promise<{ sent: number; dropped: number }> {
  ensureVapid();
  const subs: PushSubscription[] = listEnabledForUser(userId);
  if (!subs.length) return { sent: 0, dropped: 0 };
  const json = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        json,
      ),
    ),
  );
  let sent = 0;
  let dropped = 0;
  results.forEach((r, i) => {
    const sub = subs[i];
    if (r.status === 'fulfilled') {
      sent += 1;
      try {
        touchSubscription(sub.id);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const err = r.reason as webpush.WebPushError & { statusCode?: number };
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      deleteById(sub.id, sub.user_id);
      dropped += 1;
      return;
    }
    let host = '';
    try {
      host = new URL(sub.endpoint).host;
    } catch (_) {
      /* ignore */
    }
    const body = typeof err?.body === 'string' ? err.body.slice(0, 500) : '';
    console.warn(
      `[push] delivery failed for sub ${sub.id} (${host}): ` +
        `status=${status ?? '?'} message=${err?.message || String(err)} body=${body}`,
    );
  });
  return { sent, dropped };
}
