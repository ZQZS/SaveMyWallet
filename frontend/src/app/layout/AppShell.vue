<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Database, WalletCards } from 'lucide-vue-next'
import MenuNav from './MenuNav.vue'
import { useLedgerSession } from '../ledgerSession'
import { useSyncSession } from '../syncSession'
import { currentMonth } from '../../domain/ledger'
import { t } from '../../i18n'

const route = useRoute()
const { status: syncStatus } = useSyncSession()
const { data, busy, error, notice, needsReload, retryRead, updateCalendarMonth } = useLedgerSession()
let dayTimer: number

function refreshCalendar() {
  const now = new Date()
  updateCalendarMonth(currentMonth(now), route.name === 'ledger' && !route.query.entry)
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  window.clearTimeout(dayTimer)
  dayTimer = window.setTimeout(refreshCalendar, midnight.getTime() - now.getTime())
}

onMounted(() => {
  refreshCalendar()
  window.addEventListener('focus', refreshCalendar)
  document.addEventListener('visibilitychange', refreshCalendar)
  void retryRead()
})

onUnmounted(() => {
  window.clearTimeout(dayTimer)
  window.removeEventListener('focus', refreshCalendar)
  document.removeEventListener('visibilitychange', refreshCalendar)
})
</script>

<template>
  <header class="app-header">
    <div class="header-inner">
      <div class="brand"><span class="brand-mark"><WalletCards :size="22" aria-hidden="true" /></span><b>SaveMyWallet</b></div>
      <MenuNav placement="desktop" />
      <span class="local-label"><Database :size="14" aria-hidden="true" /> {{ t('app.local') }}</span>
    </div>
  </header>
  <main class="workspace">
    <p v-if="syncStatus?.conflicts.length && route.name !== 'settings-connections'" class="alert sync-alert" role="status">
      <span>{{ t('sync.conflictLink', { count: syncStatus.conflicts.length }) }}</span>
      <RouterLink :to="{ name: 'settings-connections' }">{{ t('sync.open') }}</RouterLink>
    </p>
    <div v-if="error" role="alert" class="alert error-alert">
      <span>{{ error }}</span>
      <button v-if="needsReload" type="button" :disabled="busy" @click="retryRead">{{ t('app.retry') }}</button>
    </div>
    <p v-if="!data && !error" class="loading" role="status">{{ t('app.loading') }}</p>
    <!-- Keep the current form mounted while recovering a failed snapshot read. -->
    <div v-if="data" v-show="!needsReload">
      <p v-if="notice && route.name !== 'ledger'" class="alert saved-alert" role="status">{{ notice }}</p>
      <slot />
    </div>
  </main>
  <MenuNav placement="mobile" />
</template>

<style scoped>
.app-header { background: var(--surface); border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); }
.header-inner, .workspace { max-width: 1140px; margin: 0 auto; padding-inline: clamp(18px, 4vw, 52px); }
.header-inner { display: flex; align-items: center; min-height: 66px; gap: clamp(24px, 4vw, 56px); }
.brand, .local-label { display: flex; gap: 9px; align-items: center; white-space: nowrap; }
.brand { color: var(--green); font-size: 21px; letter-spacing: -.055em; }
.brand-mark { display: grid; place-items: center; width: 33px; height: 33px; border-radius: 10px; background: var(--accent-solid); color: var(--on-accent); }
.local-label { margin-left: auto; color: var(--sub); font-size: 13px; }
.workspace { padding-block: clamp(20px, 3vw, 40px); }
.alert { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin: 0 0 16px; padding: 12px 15px; border-radius: 10px; font-size: 14px; overflow-wrap: anywhere; }
.error-alert { color: var(--danger-ink); background: var(--danger-bg); }
.sync-alert { color: var(--warning-ink); background: var(--warning-bg); }
.sync-alert a { color: inherit; font-weight: 600; }
.alert button { flex-shrink: 0; border: 1px solid currentColor; border-radius: 7px; background: transparent; color: inherit; padding: 5px 10px; }
.saved-alert { color: var(--green); background: var(--soft); }
.loading { color: var(--sub); }
@media (max-width: 860px) {
  .header-inner { min-height: 52px; padding-inline: 16px; }
  .brand { font-size: 18px; }
  .brand-mark { width: 29px; height: 29px; }
  .workspace { padding: 18px max(12px, env(safe-area-inset-right)) calc(88px + env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
}
</style>
