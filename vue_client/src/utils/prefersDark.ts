// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// This device's OS-level color-scheme preference as a live ref. Module-level
// singleton (one matchMedia listener for the app), read by the theme resolver
// when look.theme.mode is 'system'. Defaults to dark where matchMedia is
// unavailable (jsdom tests) — dark is the product default.

import { ref } from 'vue';

const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export const prefersDark = ref(query ? query.matches : true);

query?.addEventListener('change', (e) => {
  prefersDark.value = e.matches;
});
