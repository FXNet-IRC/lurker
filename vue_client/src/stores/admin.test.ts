// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin panes refetch on every mount (#613), so a slow users/invites GET can
// still be in flight when a local mutation patches the list. These lock in the
// per-resource fetch-generation guard that drops a superseded GET rather than
// letting it resurrect a just-deleted row.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import { useAdminStore, type AdminUser, type AdminInvite } from './admin.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function user(id: number, username: string): AdminUser {
  return { id, username, createdAt: '' };
}

function invite(token: string): AdminInvite {
  return { token, url: '', status: 'pending', createdAt: '', expiresAt: null, usedAt: null };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('admin store — refetch race guard (#613)', () => {
  it('an in-flight users GET cannot resurrect a locally-deleted user', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'a'), user(2, 'b')];
    store.usersLoaded = true;

    // The GET (mount refetch) stays in flight; DELETE resolves immediately.
    const getDefer = deferred<{ users: AdminUser[] }>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'DELETE' ? Promise.resolve({}) : getDefer.promise,
    );

    const fetching = store.fetchUsers(); // seq = 1, awaiting the GET
    await store.deleteUser(2); // bumps seq to 2, filters locally
    expect(store.users.map((u) => u.id)).toEqual([1]);

    // The stale GET resolves with the PRE-delete list.
    getDefer.resolve({ users: [user(1, 'a'), user(2, 'b')] });
    await fetching;

    // User 2 must not be back.
    expect(store.users.map((u) => u.id)).toEqual([1]);
  });

  it('an in-flight invites GET cannot drop a locally-created invite', async () => {
    const store = useAdminStore();
    store.invites = [invite('old')];
    store.invitesLoaded = true;

    const getDefer = deferred<{ invites: AdminInvite[] }>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'POST' ? Promise.resolve({ invite: invite('new') }) : getDefer.promise,
    );

    const fetching = store.fetchInvites(); // seq = 1, awaiting the GET
    await store.createInvite(); // bumps seq, prepends locally
    expect(store.invites.map((i) => i.token)).toEqual(['new', 'old']);

    // The stale GET resolves without the freshly-created invite.
    getDefer.resolve({ invites: [invite('old')] });
    await fetching;

    expect(store.invites.map((i) => i.token)).toEqual(['new', 'old']);
  });

  it('a fresh GET with no mutation racing applies normally', async () => {
    const store = useAdminStore();
    h.api.mockResolvedValue({ users: [user(5, 'e')] });
    await store.fetchUsers();
    expect(store.users.map((u) => u.id)).toEqual([5]);
    expect(store.usersLoaded).toBe(true);
  });
});

// The ident write reports on the WRITE, not on the bookkeeping refetch that
// follows it (#643). Getting this backwards tells an admin their save failed
// when it landed, and invites them to retry a write that already applied.
describe('admin store — setUserIdent', () => {
  it('resolves when the write succeeds even if the follow-up refetch fails', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'alice')];
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? Promise.resolve({ ok: true, ident: 'ali', effectiveIdent: 'ali' })
        : Promise.reject(new Error('network down')),
    );

    await expect(store.setUserIdent(1, 'ali')).resolves.toMatchObject({ effectiveIdent: 'ali' });
    // The row still shows the value the write returned...
    expect(store.users[0]).toMatchObject({ ident: 'ali', effectiveIdent: 'ali' });
    // ...and no error is left on the SHARED store field for the next pane to
    // render as its own failure.
    expect(store.error).toBe('');
  });

  it('still rejects when the write itself fails', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'alice')];
    h.api.mockRejectedValue(new Error('that ident is already in use by bob'));
    await expect(store.setUserIdent(1, 'bob')).rejects.toThrow(/already in use/);
    expect(store.users[0].ident).toBeUndefined();
  });

  it('refreshes conflict flags from the server after a successful write', async () => {
    // Assigning an override can clear the duplicate badge on the OTHER side of a
    // clash, which only a refetch can know.
    const store = useAdminStore();
    store.users = [
      { ...user(1, 'bob smith'), effectiveIdent: 'bobsmith', identConflict: true },
      { ...user(2, 'bobsmith'), effectiveIdent: 'bobsmith', identConflict: true },
    ];
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? Promise.resolve({ ok: true, ident: 'bobs', effectiveIdent: 'bobs' })
        : Promise.resolve({
            users: [
              { ...user(1, 'bob smith'), effectiveIdent: 'bobs', identConflict: false },
              { ...user(2, 'bobsmith'), effectiveIdent: 'bobsmith', identConflict: false },
            ],
          }),
    );

    await store.setUserIdent(1, 'bobs');
    expect(store.users.map((u) => u.identConflict)).toEqual([false, false]);
  });
});
