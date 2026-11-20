<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { menuItems } from '../menu'
import { useLedgerSession } from '../ledgerSession'
import { t } from '../../i18n'

defineProps<{ placement: 'desktop' | 'mobile' }>()
const route = useRoute()
const router = useRouter()
const { busy, needsReload } = useLedgerSession()
</script>

<template>
  <nav :class="placement + '-nav'" :aria-label="t(placement === 'desktop' ? 'nav.main' : 'nav.mobile')">
    <button v-for="item in menuItems" :key="item.name" type="button"
      :disabled="busy || needsReload" :aria-current="route.meta.menu === item.name ? 'page' : undefined"
      @click="router.push({ name: item.name })">
      <component v-if="placement === 'mobile'" :is="item.icon" :size="19" aria-hidden="true" />
      {{ t(placement === 'desktop' ? item.label : item.label + '.compact') }}
    </button>
  </nav>
</template>

<style scoped>
.desktop-nav { display: flex; gap: 24px; align-self: stretch; }
button { border: 0; border-radius: 0; background: transparent; color: var(--sub); font-weight: 550; font-size: 14px; }
.desktop-nav button { position: relative; padding: 0 2px; }
button[aria-current="page"] { color: var(--green); font-weight: 700; }
.desktop-nav button[aria-current="page"]::after { content: ""; position: absolute; inset: auto 0 0; height: 3px; background: var(--green); border-radius: 4px 4px 0 0; }
.mobile-nav { display: none; }
@media (max-width: 860px) {
  .desktop-nav { display: none; }
  .mobile-nav { display: flex; position: fixed; inset: auto 0 0; z-index: 5; border-top: 1px solid var(--line); background: var(--surface); padding: 3px 6px calc(4px + env(safe-area-inset-bottom)); }
  .mobile-nav button { display: grid; gap: 3px; justify-items: center; align-content: center; min-height: 52px; flex: 1; font-size: 12px; }
}
</style>
