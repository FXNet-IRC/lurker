// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(),
}));

import { socketSend } from '../composables/useSocket.js';
import { useNickNotesStore } from './nickNotes.js';

const send = vi.mocked(socketSend);

// A `=bob` DCC chat is a conversation with bob, so its note IS bob's note.
// Before this, a note written from the DCC chat header was persisted under
// `=bob` — a second note about the same person that the DM with bob never
// showed, and the header's "Edit note" button never found bob's real one.
describe('nick notes — DCC chat targets', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    send.mockReset();
    send.mockReturnValue(true);
  });

  it("finds the peer's existing note from the DCC chat", () => {
    const store = useNickNotesStore();
    store.applyUpdate(1, 'bob', 'met at the meetup', '2026-09-21T00:00:00Z');
    expect(store.hasNote(1, '=bob')).toBe(true);
    expect(store.noteFor(1, '=bob')).toBe('met at the meetup');
  });

  it('opens the editor on the peer, not the buffer name', () => {
    const store = useNickNotesStore();
    store.openEditor(1, '=bob');
    expect(store.editor.nick).toBe('bob');
  });

  it('saves under the peer so the DM sees the same note', () => {
    useNickNotesStore().setNote(1, '=bob', 'hi');
    expect(send).toHaveBeenCalledWith({
      type: 'set-nick-note',
      networkId: 1,
      nick: 'bob',
      note: 'hi',
    });
  });

  it('leaves an ordinary nick alone', () => {
    useNickNotesStore().setNote(1, 'alice', 'x');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ nick: 'alice' }));
  });
});
