<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  How to attach an IRC client to this instance's bouncer. The category only
  exists where the instance runs one (features.bouncer), so this pane never has
  to explain a bouncer nobody has.
-->

<template>
  <section id="bouncer" class="settings-pane">
    <h2>bouncer</h2>
    <p class="section-desc">
      Your networks stay connected here, so any IRC client can attach to them — same nick, same
      channels, recent history replayed, and anything you send lands in Lurker too. Detaching never
      disconnects you from IRC.
    </p>

    <dl class="connect">
      <dt>server</dt>
      <dd>
        <code>{{ host }}</code>
        <span class="muted small"> port </span>
        <code>{{ port }}</code>
        <span class="muted small">{{ tls ? ' — connect in your client’s TLS/SSL mode' : '' }}</span>
      </dd>
      <dt>username</dt>
      <dd>
        <code>{{ username }}</code>
        <span class="muted small"> for every network at once</span>
      </dd>
      <dt v-if="networkNames.length > 0">one network</dt>
      <dd v-if="networkNames.length > 0">
        <code>{{ username }}/{{ networkNames[0] }}</code>
        <span v-if="networkNames.length > 1" class="muted small">
          — or {{ networkNames.slice(1).join(', ') }}
        </span>
      </dd>
      <dt>password</dt>
      <dd>
        your Lurker password, or
        <RouterLink to="/settings/api-tokens">an API token</RouterLink>
      </dd>
    </dl>

    <p v-if="!pinned" class="muted small">
      That’s this instance’s own hostname and listener. If your bouncer answers somewhere else — a
      separate hostname, or TLS terminated in front of it — whoever runs this server can say so with
      <code>LURKER_BOUNCER_PUBLIC_URL</code>.
    </p>

    <p class="muted small">
      An API token is the better password here: IRC clients keep the server password in a plaintext
      config file, and a token can be revoked on its own. Revoking it disconnects the clients using
      it.
    </p>

    <p class="muted small">
      Clients that speak <code>soju.im/bouncer-networks</code> (Goguma, gamja, Halloy) list your
      networks and pick one themselves, so plain <code>{{ username }}</code> is all they need.
      Anything else (WeeChat, irssi, HexChat) lands on an idle connection that names the networks it
      can attach to.
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api.js';
import { useAuthStore } from '../../stores/auth.js';
import { useNetworksStore } from '../../stores/networks.js';

const auth = useAuthStore();
const networks = useNetworksStore();

// What the server says to connect to. `host` is null when the operator hasn't
// pinned an address: the bouncer can't sit behind the HTTP reverse proxy (it
// terminates its own TLS), so the web origin isn't reliably its address —
// the hostname this page is on is the better guess, and `pinned` says which
// of the two the pane is showing.
interface BouncerInfo {
  host: string | null;
  port: number;
  tls: boolean;
  pinned: boolean;
}
const info = ref<BouncerInfo | null>(null);
onMounted(async () => {
  try {
    info.value = await api<BouncerInfo>('/api/bouncer');
  } catch {
    /* the pane still explains the shape of a login; only the address is unknown */
  }
});

const host = computed(() => info.value?.host || window.location.hostname);
const port = computed(() => info.value?.port ?? 6667);
const tls = computed(() => info.value?.tls !== false);
const pinned = computed(() => info.value?.pinned === true);
const username = computed(() => auth.user?.username || 'username');
const networkNames = computed(() => networks.networks.map((n) => n.name));
</script>

<style src="./panes.css"></style>
<style scoped>
.connect {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-5);
  margin: var(--space-6) 0;
}
.connect dt {
  color: var(--muted);
}
.connect dd {
  margin: 0;
}
</style>
