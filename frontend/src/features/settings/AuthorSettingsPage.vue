<script setup lang="ts">
import { t } from '../../i18n'
import SettingsPageFrame from './SettingsPageFrame.vue'
</script>

<template>
  <SettingsPageFrame :title="t('settings.author.title')">
    <dl class="settings-sheet author-info">
      <div>
        <dt>{{ t('settings.author.name') }}</dt>
        <dd>宅师OvO</dd>
      </div>
      <div>
        <dt>{{ t('settings.author.message') }}</dt>
        <dd>主要是方便记录B站的会员购，后面想着，既然都做了，那把花呗也做了吧，那做都做了，那就......</dd>
      </div>
      <div>
        <dt>{{ t('settings.author.contact') }}</dt>
        <dd>有缘自会相识</dd>
      </div>
    </dl>
  </SettingsPageFrame>
</template>

<style scoped>
.author-info { margin: 0; gap: 0; }
.author-info > div { display: grid; grid-template-columns: 7em minmax(0, 1fr); gap: 12px; padding-block: 12px; }
.author-info > div + div { border-top: 1px solid var(--line); }
.author-info dt { color: var(--sub); }
.author-info dd { margin: 0; overflow-wrap: anywhere; }
</style>
