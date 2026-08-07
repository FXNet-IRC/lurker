<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0

  Appearance: bespoke only for the leading Themes section — every actual
  appearance option below it is still ordinary registry rows, rendered by the
  embedded RegistryPane (the UploadsPane pattern). The embedded pane keeps
  emitting the [data-setting-group] headings Settings.vue's scroll-spy and
  subsection sidebar depend on; ThemesSection contributes its own 'themes'
  heading, mirrored by the extra subsection entry in Settings.vue.
-->

<template>
  <section id="appearance" class="settings-pane">
    <h2>Appearance</h2>
    <ThemesSection />
    <RegistryPane category-id="appearance" embedded />
  </section>
</template>

<script setup lang="ts">
import RegistryPane from './RegistryPane.vue';
import ThemesSection from './ThemesSection.vue';
</script>

<style src="./panes.css"></style>
