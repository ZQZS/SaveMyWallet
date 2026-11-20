<script setup lang="ts">
import { t } from '../../i18n'
import SettingsPageFrame from './SettingsPageFrame.vue'

defineProps<{ kind: 'ai' | 'pets' }>()
</script>

<template>
  <SettingsPageFrame :title="t('settings.' + kind + '.title')">
    <section class="settings-sheet">
      <h2>{{ t('settings.planned') }}</h2>
      <p class="settings-muted">{{ t('settings.plan.' + kind) }}</p>
    </section>
  </SettingsPageFrame>
</template>
