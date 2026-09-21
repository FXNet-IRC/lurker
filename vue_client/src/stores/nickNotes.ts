// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { dccChatPeer } from '../../../shared/channels.js';

// Per-(network, nick) free-form notes about a contact. Server is the source
// of truth — saves ship over WS and a `nick-note-updated` echo fans out to
// every session belonging to the user so notes stay in sync across devices.
// Same nick on different networks is two different people, so the keying is
// network-scoped (mirrors ignores).
//
// Editor state lives in the store too — the modal is mounted once at the
// top of the chat view and watches `editor.open`, so any call site
// (nicklist menu, DM context menu, sidebar) can open it without owning the
// component.
// ⚠ A `=bob` DCC chat is a conversation with bob, so its note IS bob's note.
// Normalized in the key (every lookup) and again wherever the nick leaves this
// store (the editor, the server write) — otherwise a note written from a DCC
// buffer is persisted under `=bob`, a second note about the same person that
// the DM with bob never shows.
function key(networkId: number | string, nick: string) {
  return `${networkId}::${dccChatPeer(nick || '').toLowerCase()}`;
}

export interface NickNoteEntry {
  note: string;
  updatedAt: string | null;
}

export interface NickNoteEditorState {
  open: boolean;
  networkId: number | null;
  nick: string;
}

export const useNickNotesStore = defineStore('nickNotes', {
  state: () => ({
    // { [networkId::nicklower]: { note: string, updatedAt: string } }
    byKey: {} as Record<string, NickNoteEntry>,
    editor: { open: false, networkId: null, nick: '' } as NickNoteEditorState,
  }),
  getters: {
    noteFor: (state) => (networkId: number | string, nick: string) =>
      state.byKey[key(networkId, nick)]?.note || '',
    hasNote: (state) => (networkId: number | string, nick: string) => {
      const entry = state.byKey[key(networkId, nick)];
      return !!(entry && entry.note);
    },
    entryFor: (state) => (networkId: number | string, nick: string) =>
      state.byKey[key(networkId, nick)] || null,
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<string, NickNoteEntry> = {};
      for (const n of networks || []) {
        if (n?.networkId == null) continue;
        for (const entry of n.nickNotes || []) {
          if (!entry?.nick) continue;
          next[key(n.networkId, entry.nick)] = {
            note: entry.note || '',
            updatedAt: entry.updatedAt || null,
          };
        }
      }
      this.byKey = next;
    },
    applyUpdate(networkId: number | string, nick: string, note: string, updatedAt: string) {
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      if (note) {
        this.byKey[k] = { note, updatedAt: updatedAt || null };
      } else {
        delete this.byKey[k];
      }
    },
    setNote(networkId: number | string, nick: string, note: string) {
      if (!networkId || !nick) return;
      socketSend({ type: 'set-nick-note', networkId, nick: dccChatPeer(nick), note: note || '' });
    },
    openEditor(networkId: number | string, nick: string) {
      if (!networkId || !nick) return;
      this.editor = { open: true, networkId: Number(networkId), nick: dccChatPeer(nick) };
    },
    closeEditor() {
      this.editor = { open: false, networkId: null, nick: '' };
    },
  },
});
