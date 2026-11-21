<script setup lang="ts">
import { t } from '../../i18n'
import SettingsPageFrame from './SettingsPageFrame.vue'
</script>

<template>
  <SettingsPageFrame :title="t('settings.pets.title')">
    <section class="settings-sheet">
      <h2>{{ t('settings.planned') }}</h2>
      <p class="settings-muted">{{ t('settings.plan.pets') }}</p>
    </section>
  </SettingsPageFrame>
</template>
