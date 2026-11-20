<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useLedgerSession } from '../../app/ledgerSession'
import { t } from '../../i18n'
import './settings.css'

defineProps<{ title: string }>()
const { busy, needsReload } = useLedgerSession()
const router = useRouter()
</script>

<template>
  <section class="settings-page" aria-labelledby="settings-page-title">
    <header class="settings-header">
      <button type="button" class="settings-back" :disabled="busy || needsReload" @click="router.push({ name: 'settings' })">
        <ChevronLeft :size="16" aria-hidden="true" />{{ t('settings.title') }}
      </button>
      <h1 id="settings-page-title">{{ title }}</h1>
    </header>
    <slot />
  </section>
</template>
