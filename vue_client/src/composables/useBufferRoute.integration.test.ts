// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The sibling suite mocks vue-router, which makes navigation synchronous and so
// cannot see the bug this file exists for: router.push resolves ASYNCHRONOUSLY,
// and everything that reads `route.params` to decide whether to navigate is
// reading a value that lags a push by a tick. These run against the real router.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

const s = reactive({
  networks: { activeKey: null as string | null },
  buffers: {} as Record<string, { id?: number; networkId: number | null; target: string }>,
});

vi.mock('./useSocket.js', () => ({ connected: { value: true } }));
vi.mock('../stores/networks.js', () => ({ useNetworksStore: () => s.networks }));
vi.mock('../stores/toasts.js', () => ({ useToastsStore: () => ({ push: () => {} }) }));
vi.mock('../stores/buffers.js', () => ({
  useBuffersStore: () => ({
    byKey: (k: string) => s.buffers[k] ?? null,
    byId: (id: number) => Object.values(s.buffers).find((b) => b.id === id) ?? null,
    activate: (networkId: number | null, target: string) => {
      s.networks.activeKey = networkId == null ? target : `${networkId}::${target}`;
    },
  }),
  bufferKey: (networkId: number | null, target: string) =>
    networkId == null ? target : `${networkId}::${target}`,
}));

import { useBufferRoute, pushBuffer } from './useBufferRoute.js';

function known(key: string, id: number): void {
  const sep = key.indexOf('::');
  s.buffers[key] = { networkId: Number(key.slice(0, sep)), target: key.slice(sep + 2), id };
}

/** Let an in-flight navigation actually land, the way a real gesture would. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const mounted: Array<{ unmount: () => void }> = [];

async function mkApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'chat', component: { render: () => null } },
      { path: '/buffer/:id', name: 'buffer', component: { render: () => null } },
      { path: '/buffer/:id/members', name: 'buffer-members', component: { render: () => null } },
    ],
  });
  const app = mount(
    defineComponent({
      setup() {
        useBufferRoute();
        return () => h(RouterView);
      },
    }),
    { global: { plugins: [router] } },
  );
  // Record only once the initial `/` navigation has landed, so `navs` counts
  // what the test does rather than the router booting.
  mounted.push(app);
  await router.isReady();
  const navs: string[] = [];
  router.afterEach((to) => navs.push(to.fullPath));
  return { router, app, navs };
}

/** Tap a row in the buffer list: the store activates, the shell navigates. */
async function tapBuffer(
  router: Awaited<ReturnType<typeof mkApp>>['router'],
  key: string,
  id: number,
) {
  s.networks.activeKey = key;
  pushBuffer(router, id); // what MobileChat's openActiveBuffer does
  await settle();
}

beforeEach(() => {
  s.networks.activeKey = null;
  s.buffers = {};
});

afterEach(() => {
  // Every mount adds another useBufferRoute, and they SHARE the module-level
  // in-flight guard — a leaked one will swallow the next test's navigation and
  // push it into a stale router. (Found the hard way: four live instances made
  // an entire suite pass for the wrong reason.)
  while (mounted.length) mounted.pop()?.unmount();
});

describe('useBufferRoute against the real router', () => {
  it('opens a buffer with exactly ONE navigation', async () => {
    known('1::#a', 7);
    const { router, navs } = await mkApp();

    await tapBuffer(router, '1::#a', 7);

    // Two pushes land two history entries for one tap, so the first swipe back
    // appears to do nothing — and the interleaved navigations resolve through
    // an intermediate route naming the PREVIOUS buffer, which is visible as the
    // wrong channel highlighted in the list.
    expect(navs).toEqual(['/buffer/7']);
  });

  it('leaves the active buffer alone when swiping back to the list', async () => {
    known('1::#a', 7);
    known('1::#b', 8);
    const { router, navs } = await mkApp();

    await tapBuffer(router, '1::#a', 7);
    await router.push('/'); // back arrow to the list
    await settle();
    await tapBuffer(router, '1::#b', 8);
    navs.length = 0;

    router.back(); // the swipe
    await settle();

    expect(router.currentRoute.value.fullPath).toBe('/');
    // The list highlights whatever activeKey names. Landing here with #a active
    // — because a stray navigation resolved through /buffer/7 on the way — is
    // the flash of the wrong row reported on device.
    expect(s.networks.activeKey).toBe('1::#b');
    expect(navs).toEqual(['/']);
  });

  it('walks one screen per gesture: members -> buffer -> list', async () => {
    known('1::#a', 7);
    const { router } = await mkApp();

    await tapBuffer(router, '1::#a', 7);
    await router.push('/buffer/7/members');
    await settle();

    router.back();
    await settle();
    expect(router.currentRoute.value.name).toBe('buffer');

    router.back();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/');
  });
});

describe('navigating off the members screen', () => {
  it('goes to the buffer even though the members route carries the same id', async () => {
    // `/buffer/7/members` has params.id === '7' too, so a guard that only
    // compares the id reads it as "already there" and does nothing. Then a jump
    // to the buffer you are ALREADY in — an in-app toast (#444), a search hit —
    // can't carry you off the member list, and the messages scroll underneath
    // it unseen.
    known('1::#a', 7);
    const { router } = await mkApp();
    await tapBuffer(router, '1::#a', 7);
    await router.push('/buffer/7/members');
    await settle();

    pushBuffer(router, 7); // what useJumpToMessage's afterActivate does
    await settle();

    expect(router.currentRoute.value.name).toBe('buffer');
    expect(router.currentRoute.value.fullPath).toBe('/buffer/7');
  });
});

describe('a cold-start deep link vs. a later activation', () => {
  it('lets ANY activation take the URL from a pending resolution', async () => {
    // Documenting the contract, not a wish: while `/buffer/7` is still waiting
    // on the socket, an activation of something else wins and cancels the wait.
    // That has to be so — a user who clicks another buffer mid-resolve must not
    // be left on a URL naming somewhere they aren't, then yanked there when it
    // resolves.
    //
    // The cost is that a DEFAULT activation wins too, which is how a cold deep
    // link came to be overwritten by the system buffer. The guard therefore
    // lives at the default's call site, where deliberate and default can be
    // told apart — see utils/defaultBuffer.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'chat', component: { render: () => null } },
        { path: '/buffer/:id', name: 'buffer', component: { render: () => null } },
        { path: '/buffer/:id/members', name: 'buffer-members', component: { render: () => null } },
      ],
    });
    await router.push('/buffer/7');
    const app = mount(
      defineComponent({
        setup() {
          useBufferRoute();
          return () => h(RouterView);
        },
      }),
      { global: { plugins: [router] } },
    );
    mounted.push(app);
    await settle();

    known('2::#other', 3);
    s.networks.activeKey = '2::#other';
    await settle();

    expect(router.currentRoute.value.fullPath).toBe('/buffer/3');

    // And the abandoned wait is dead: buffer 7 arriving later must not drag the
    // user back.
    known('1::#a', 7);
    await settle();
    expect(s.networks.activeKey).toBe('2::#other');
  });
});
