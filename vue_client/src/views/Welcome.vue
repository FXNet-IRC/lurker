<!--
  Copyright (c) 2026 FXNet
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="welcome">
    <WordBackdrop word="chat" />
    <div class="card">
      <h1>chat</h1>
      <p class="subtitle">Jump in — no account needed. Pick a nickname and start chatting.</p>

      <form @submit.prevent="onJoin">
        <label>
          <span>Nickname</span>
          <input
            v-model="nick"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            maxlength="16"
            autofocus
            placeholder="optional — we'll pick one if blank"
          />
        </label>
        <p class="hint">You can change it any time once you're in with <code>/nick</code>.</p>
        <button type="submit" class="btn-primary" :disabled="working">
          {{ working ? 'Connecting…' : 'Join the chat' }}
        </button>
      </form>

      <p class="signin">
        Already have an account?
        <RouterLink :to="loginDestination">Sign in</RouterLink>
      </p>

      <p v-if="auth.error" class="error">{{ auth.error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, useRoute, type RouteLocationRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import WordBackdrop from '../components/WordBackdrop.vue';

const nick = ref('');
const working = ref(false);
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

// Preserve any ?next= so signing in lands where the guest was originally headed.
const loginDestination = computed<RouteLocationRaw>(() => ({
  name: 'login',
  query: typeof route.query.next === 'string' ? { next: route.query.next } : {},
}));

function nextDestination(): string {
  const next = route.query.next;
  return typeof next === 'string' && next ? next : '/';
}

async function onJoin() {
  working.value = true;
  try {
    await auth.startGuest(nick.value.trim() || undefined);
    router.replace(nextDestination());
  } catch (_) {
    // displayed via auth.error
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.welcome {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.card {
  position: relative;
  z-index: var(--z-base);
  width: min(380px, 92vw);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  padding: var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
h1 {
  margin: 0 0 var(--space-2);
  color: var(--accent);
  font-weight: 700;
  text-transform: lowercase;
  font-size: clamp(2.5rem, 5vw, 3.5rem);
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.subtitle {
  margin: 0;
  color: var(--fg-muted);
}
form {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin: 0;
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--fg-muted);
}
label span {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.hint {
  margin: 0;
  color: var(--fg-muted);
}
.hint code {
  font-family: var(--font-mono, monospace);
}
.signin {
  margin: 0;
  color: var(--fg-muted);
  text-align: center;
}
.error {
  margin: 0;
  color: var(--bad);
}
</style>
