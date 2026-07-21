// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useConfigStore } from './stores/config.js';
import { useToastsStore } from './stores/toasts.js';
import { isChunkLoadError, safeSessionStorage, shouldReloadFor } from './lib/chunkReload.js';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/welcome', name: 'welcome', component: () => import('./views/Welcome.vue') },
  { path: '/invite/:token', name: 'invite', component: () => import('./views/InviteAccept.vue') },
  {
    path: '/',
    name: 'chat',
    component: () => import('./views/Chat.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/settings/:category?',
    name: 'settings',
    component: () => import('./views/Settings.vue'),
    meta: { requiresAuth: true },
  },
  {
    // Dedicated admin panel (Milestone 4), gated on the admin role by the guard
    // below. It is where all instance administration lives; there is no longer a
    // Users category inside Settings.
    path: '/admin/:tab?',
    name: 'admin',
    component: () => import('./views/Admin.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const config = useConfigStore();
  // Resolve config before deciding public-vs-login, otherwise the first
  // navigation can misroute (the landing choice depends on publicMode).
  if (!config.checked) await config.fetch();
  if (!auth.checked) await auth.fetchMe();
  if (to.meta.requiresAuth && !auth.user) {
    // In public webchat mode, send anonymous visitors to the join-as-guest
    // landing instead of the sign-in page.
    const name = config.isPublicMode ? 'welcome' : 'login';
    return { name, query: { next: to.fullPath } };
  }
  // Authenticated users have no business on the entry screens.
  if ((to.name === 'login' || to.name === 'welcome') && auth.user) return { name: 'chat' };
  // Non-admins bounce to Settings rather than render a forbidden shell. Every
  // admin API is requireAdmin-gated regardless — this only decides what renders.
  if (to.meta.requiresAdmin && !auth.isAdmin) return { name: 'settings' };
});

// A lazy-route chunk that fails to load leaves the route permanently dead for
// this document (see lib/chunkReload.ts). Recover by reloading into the target
// so the user gets the page they asked for rather than a button that silently
// does nothing forever (#571).
router.onError((err, to) => {
  if (!isChunkLoadError(err)) return;
  const path = to?.fullPath;
  if (!path) return;
  if (shouldReloadFor(path, Date.now(), safeSessionStorage())) {
    window.location.assign(path);
    return;
  }
  // Already tried reloading for this path — the chunk is genuinely unavailable,
  // so reloading again would boot-loop. Tell the user instead: Lurker runs as a
  // PWA where there is no console to check, so a silent failure here is
  // indistinguishable from the bug we're fixing.
  useToastsStore().push({
    title: "Couldn't open that page",
    body: 'Part of the app failed to load. Reopening Lurker should fix it.',
    kind: 'error',
    ttlMs: 8000,
  });
});

export default router;
