// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// #590 gave the consumed rows a working control where a disabled em-dash used to
// sit, and the two states now share one button whose label, tooltip, confirm text
// and error message all branch on the row. That is exactly the label-vs-action
// drift shape: a button that says "revoke" while doing something else, or that
// reads the wrong row at click time, is invisible to any test of the handler
// alone. Mount it and click.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import { useAdminStore, type AdminInvite } from '../../stores/admin.js';
import InvitesPane from './InvitesPane.vue';

function invite(over: Partial<AdminInvite> & { token: string }): AdminInvite {
  return {
    url: `https://example.test/invite/${over.token}`,
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    usedAt: null,
    usedByUsername: null,
    ...over,
  };
}

const PENDING = invite({ token: 'tok-pending' });
const CONSUMED = invite({
  token: 'tok-consumed',
  status: 'consumed',
  usedAt: '2026-01-05T00:00:00.000Z',
  usedByUsername: 'newcomer',
});

let deleteInvite: ReturnType<typeof vi.fn<(token: string) => Promise<void>>>;

// happy-dom ships no window.confirm, so there is nothing to spy on — install one.
function stubConfirm(answer: boolean) {
  // Typed with the message parameter so the recorded calls carry the prompt
  // text these tests read back.
  const fn = vi.fn<(message?: string) => boolean>((_message?: string) => answer);
  window.confirm = fn as unknown as typeof window.confirm;
  return fn;
}

function mountPane(invites: AdminInvite[]): VueWrapper {
  const store = useAdminStore();
  store.invites = invites;
  store.invitesLoaded = true;
  store.fetchInvites = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  deleteInvite = vi.fn<(token: string) => Promise<void>>().mockResolvedValue(undefined);
  store.deleteInvite = deleteInvite as unknown as typeof store.deleteInvite;
  return mount(InvitesPane);
}

// The row action is the last button in each row.
function rowButton(wrapper: VueWrapper, token: string) {
  const row = wrapper.findAll('.invite-row').find((r) => r.text().includes(token));
  if (!row) throw new Error(`no row for ${token}`);
  const buttons = row.findAll('button');
  return buttons[buttons.length - 1];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

describe('InvitesPane row action (#590)', () => {
  it('offers a working control on a consumed invite, not a disabled placeholder', async () => {
    const wrapper = mountPane([CONSUMED]);
    const btn = rowButton(wrapper, 'tok-consumed');
    expect(btn.text()).toBe('remove');
    expect(btn.attributes('disabled')).toBeUndefined();
  });

  it('calls it revoke while the link can still be redeemed', () => {
    const wrapper = mountPane([PENDING]);
    expect(rowButton(wrapper, 'tok-pending').text()).toBe('revoke');
  });

  it('deletes the row it was clicked on, not whichever is active', async () => {
    // Both rows present: the handler has to carry the row through, so a global
    // read (or a stale closure) shows up here as the wrong token.
    const wrapper = mountPane([PENDING, CONSUMED]);
    stubConfirm(true);

    await rowButton(wrapper, 'tok-consumed').trigger('click');
    expect(deleteInvite).toHaveBeenCalledWith('tok-consumed');

    await rowButton(wrapper, 'tok-pending').trigger('click');
    expect(deleteInvite).toHaveBeenLastCalledWith('tok-pending');
  });

  it('warns about the link only when there is still a link to kill', async () => {
    const wrapper = mountPane([PENDING, CONSUMED]);
    const confirmed = stubConfirm(true);

    await rowButton(wrapper, 'tok-pending').trigger('click');
    expect(confirmed.mock.calls[0][0]).toMatch(/no longer be able to use it/);

    await rowButton(wrapper, 'tok-consumed').trigger('click');
    // Says who stays, so "remove" can't be read as removing the member.
    expect(confirmed.mock.calls[1][0]).toMatch(/newcomer stays/);
  });

  it('does nothing when the confirm is dismissed', async () => {
    const wrapper = mountPane([CONSUMED]);
    stubConfirm(false);
    await rowButton(wrapper, 'tok-consumed').trigger('click');
    expect(deleteInvite).not.toHaveBeenCalled();
  });
});
