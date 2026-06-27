// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { useConfigStore } from './stores/config.js';

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
});

export default router;
