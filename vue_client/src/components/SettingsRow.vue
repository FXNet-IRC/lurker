<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <li
    class="row"
    :class="{ modified, inactive: !!hint }"
    :data-setting-key="opt.key"
    :title="modified ? 'modified from default' : ''"
  >
    <div class="head">
      <span class="headline">{{ opt.label || opt.key }}</span>
      <span class="type">{{ opt.type }}</span>
      <button v-if="modified" class="link reset" @click="$emit('reset')" title="reset to default">
        reset
      </button>
    </div>
    <div class="key-sub">
      <code>{{ opt.key }}</code>
    </div>
    <div class="desc">{{ opt.description }}</div>
    <div class="editor">
      <label v-if="opt.type === 'bool'" class="bool">
        <input
          type="checkbox"
          :checked="!!value"
          :disabled="!!hint"
          @change="$emit('commit', ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ value ? 'on' : 'off' }}</span>
      </label>
      <input
        v-else-if="opt.type === 'int'"
        type="number"
        :min="opt.min"
        :max="opt.max"
        :value="value"
        :disabled="!!hint"
        @change="onIntChange"
      />
      <select
        v-else-if="opt.type === 'enum'"
        :value="value"
        :disabled="!!hint"
        @change="$emit('commit', ($event.target as HTMLSelectElement).value)"
      >
        <!--
          `choiceLabels` is optional: an enum whose values already read as
          English (auto / standard / compact) renders them raw, and one whose
          values are ids gets prose without those ids having to change.
        -->
        <option v-for="c in opt.choices" :key="c" :value="c">
          {{ opt.choiceLabels?.[c] ?? c }}
        </option>
      </select>
      <span v-else-if="opt.type === 'color'" class="color-edit">
        <span class="swatch" :style="{ background: value as string }"></span>
        <input
          type="text"
          :value="value"
          :disabled="!!hint"
          @change="$emit('commit', ($event.target as HTMLInputElement).value)"
        />
      </span>
      <textarea
        v-else-if="opt.type === 'string-list'"
        :value="(Array.isArray(value) ? value : []).join('\n')"
        :disabled="!!hint"
        @change="
          $emit(
            'commit',
            ($event.target as HTMLTextAreaElement).value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        "
        rows="6"
      ></textarea>
      <span v-else-if="opt.type === 'secret'" class="secret-edit">
        <input
          :type="revealed ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          :value="value"
          :disabled="!!hint"
          @change="$emit('commit', ($event.target as HTMLInputElement).value)"
        />
        <button type="button" class="link reveal" @click="revealed = !revealed">
          {{ revealed ? 'hide' : 'show' }}
        </button>
      </span>
      <input
        v-else
        type="text"
        :value="value"
        :disabled="!!hint"
        @change="$emit('commit', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <!-- A locally-caught invalid int (the minNonzero hole). The typed value is
         NOT committed, so nothing round-trips just to be rejected. -->
    <p v-if="intError" class="error inline">{{ intError }}</p>
    <!--
      Why this row is greyed out, and which setting to change to wake it up.
      The value behind it is untouched — see optionEnabled() — so flipping the
      dependency back restores exactly what was here.
    -->
    <p v-if="hint" class="dep-hint">{{ hint }}</p>
    <div v-if="modified" class="default-line">
      default:
      <code>{{ formatDefault(opt, baseline !== undefined ? baseline : opt.default) }}</code>
    </div>
  </li>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { SettingOption, SettingValue } from '../../../shared/settingsRegistry.js';

const props = withDefaults(
  defineProps<{
    opt: SettingOption;
    value?: SettingValue;
    modified?: boolean;
    /**
     * What resetting this row would restore. Defaults to `opt.default`, but a
     * themed key under a non-default theme resets to the THEME's value — the
     * annotation must advertise the value reset actually produces, so the
     * caller passes the resolved baseline (settings.baseline(key)).
     */
    baseline?: SettingValue;
    /**
     * Non-empty when the setting's `dependsOn` clauses don't currently hold:
     * the explanation to show, and the flag that greys the editor out. Empty
     * (the default) for an ordinary live row.
     */
    hint?: string;
  }>(),
  {
    value: undefined,
    modified: false,
    baseline: undefined,
    hint: '',
  },
);

const emit = defineEmits<{
  commit: [value: SettingValue];
  reset: [];
}>();

const revealed = ref(false);

// The one int constraint <input min/max> can't express: minNonzero leaves a
// hole (valid: 0 or >= floor). Caught here so the hole never commits — the
// server's validate() would reject it anyway, but a round-trip that exists
// only to fail is worse than an inline line. Wording stays neutral (what 0
// MEANS is the description's job) and matches the server's own error.
const intError = ref('');
function onIntChange(e: Event) {
  const n = Number((e.target as HTMLInputElement).value);
  const o = props.opt;
  if (o.type === 'int' && typeof o.minNonzero === 'number' && n !== 0 && n < o.minNonzero) {
    intError.value = `Must be 0 or at least ${o.minNonzero.toLocaleString()}.`;
    return;
  }
  intError.value = '';
  emit('commit', n);
}

function formatDefault(opt: SettingOption, v: SettingValue): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  // Same lookup the <select> does. This line exists to tell the user what they
  // changed away from, so it has to name it the way the control does — showing
  // the id here while the dropdown above shows prose reads as a different value.
  if (opt.type === 'enum') return opt.choiceLabels?.[String(v)] ?? String(v);
  return String(v);
}
</script>

<style scoped>
.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) 0 var(--space-4) var(--space-4);
  border-top: 1px solid var(--border);
  border-left: 2px solid transparent;
  list-style: none;
}
.row:first-child {
  border-top: none;
}
.row:hover {
  background: var(--bg-soft);
}
.row.modified {
  border-left-color: var(--warn);
}
.row.modified .headline {
  color: var(--warn);
}

/* Dimmed, not hidden: an inactive setting still tells the reader it exists and
   what it would do, which is how they learn the tier controls it. */
.row.inactive .headline,
.row.inactive .desc,
.row.inactive .editor {
  opacity: 0.55;
}
.dep-hint {
  margin: 0;
  color: var(--fg-muted);
  font-style: italic;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-5);
}
.headline {
  font-weight: 600;
}
.type {
  color: var(--fg-muted);
  border: 1px solid var(--border);
  padding: 0 var(--space-2);
  text-transform: lowercase;
}
.key-sub code {
  color: var(--fg-muted);
  background: var(--bg-soft);
  padding: 0 var(--space-2);
}
.desc {
  color: var(--fg-muted);
}

.editor {
  margin-top: var(--space-1);
}
.editor input[type='text'],
.editor select {
  min-width: 280px;
}
.editor input[type='number'] {
  width: 120px;
}
.editor textarea {
  width: 100%;
  max-width: 480px;
  resize: vertical;
}
.editor .bool {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
}
.editor .color-edit {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.editor .secret-edit {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.editor .secret-edit input {
  flex: 1;
}
.editor .secret-edit .reveal {
  white-space: nowrap;
}
.editor .swatch {
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  display: inline-block;
}
.default-line {
  color: var(--fg-muted);
}
.default-line code {
  background: var(--bg-soft);
  padding: 0 var(--space-2);
}

.link {
  background: none;
  border: 0;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
.link:hover {
  color: var(--fg);
}
.link:disabled {
  color: var(--fg-muted);
  text-decoration: none;
  cursor: default;
}
.link.danger {
  color: var(--bad);
}
.link.reset {
  color: var(--fg-muted);
}
</style>
