// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// "Bind a text input to a ref without v-model, so an IME can't freeze it —
// and don't let the IME's own Enter run your action."
//
// v-model on a native <input>/<textarea> compiles to vModelText, which carries a
// `composing` flag — set between compositionstart and compositionend — and refuses
// to do anything while it is up. Its input listener opens with
// `if (e.target.composing) return`, and its beforeUpdate hook bails the same way
// before it would write. On a desktop CJK IME that covers a candidate session; on
// an Android soft keyboard with suggestions on it covers EVERY WORD, first letter
// to space. Firefox on Android composes the most aggressively of the mobile
// engines, which is where this first surfaced (lurker#624).
//
// Both halves of that guard hurt anything that reads the model as you type:
//   - READ  — a live filter list, or a submit button gated on the model, sits a
//             whole word stale. The tell is "it updates the moment I dismiss the
//             keyboard": that's compositionend delivering the word in one go. A
//             single-word field (a channel name, a token name) has no spaces at
//             all, so the gate can stay wrong for the entire value.
//   - WRITE — a programmatic `model.value = ''` (a clear button, an Esc, a reset
//             after save) does not reach the DOM, leaving text on screen the model
//             no longer holds.
//
// A plain `:value` binding has no such flag: patchDOMProp writes el.value whenever
// the model differs and skips when it doesn't, so normal typing leaves the caret
// alone while a genuine divergence still repaints. Paired with the unconditional
// input handler below, model and DOM track each other in both directions no matter
// what the IME is doing.
//
//   const onQueryInput = useImeSafeInput(query);
//   <input :value="query" @input="onQueryInput" />
//
// ─── The catch: preedit is now live, so Enter needs its own gate ─────────────
//
// v-model's frozen model was accidentally protecting one thing. A CJK user
// pressing Enter to CONFIRM a candidate fires a keydown like any other, and a
// field bound with v-model answered it with the pre-composition value — usually
// '', so the form's submit handler hit its own `if (!name) return` and no-op'd.
// Unfreeze the model and that same Enter runs the action against raw preedit:
// a theme saved as "nihao" and the field cleared out from under the user.
//
// So a field that DOES something on Enter — an explicit @keydown, or implicit
// form submission from a single-line input — needs isImeKey / blockImeEnter
// below. A filter that only filters needs neither; a <textarea> in a form needs
// neither either, since Enter there inserts a newline rather than submitting.
//
// That gate is a SEPARATE question from the binding, and a field can need one
// without the other. A single-line input still on v-model needs it too: its
// stale model doesn't make an early submit harmless, it just changes what gets
// submitted (UploaderConfigForm's Name field is the worked example — see the
// note there).
//
// ─── Scope ──────────────────────────────────────────────────────────────────
//
// Deliberately the read half only. The composer (MessageInput.vue) needs more —
// it re-runs on change/compositionend as backstops and re-establishes the write
// guard in the drafts store, because a missed sync there corrupts a sent message.
// See the "IME composition" note there. Callers of THIS never splice into the
// field mid-composition, so `input` alone is the whole premise.
//
// Fields NOT bound this way are the ones nothing reads until submit: v-model is
// fine there, because compositionend lands the value long before the click.

import type { Ref } from 'vue';

/**
 * The text the user can actually see, read straight off the element rather than
 * through a binding that may be holding something older.
 *
 * For fields that can't hand over a ref — a `reactive()` form object, a row in a
 * `v-for`. Pair with `:value`, same as useImeSafeInput.
 */
export function imeSafeValue(e: Event): string {
  const el = e.target as HTMLInputElement | HTMLTextAreaElement | null;
  return el ? el.value : '';
}

/** Ready-made @input handler for the common case: one ref mirroring one field. */
export function useImeSafeInput(model: Ref<string>) {
  return (e: Event) => {
    model.value = imeSafeValue(e);
  };
}

/**
 * True when a keydown belongs to the IME rather than to us: it is driving a
 * candidate window, not asking for an action.
 *
 * keyCode 229 is checked alongside `isComposing` because Safari fires the Enter
 * that CONFIRMS a CJK composition *after* compositionend — isComposing already
 * false, keyCode still 229 (the standard ProseMirror/Slate guard). This is the
 * same rule the composer's onKeydown states; see the comment there for why it
 * gates the whole handler rather than individual branches.
 */
export function isImeKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/**
 * Stop an IME's Enter from implicitly submitting the form the field sits in.
 *
 * Bind as `@keydown.enter="blockImeEnter"`. Deliberately NOT the `.prevent`
 * modifier: a real Enter must still submit, so the default is only cancelled for
 * the key the IME is consuming.
 */
export function blockImeEnter(e: KeyboardEvent): void {
  if (isImeKey(e)) e.preventDefault();
}
