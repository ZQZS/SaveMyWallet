import { createApp, watchEffect } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import App from './App.vue'
import { createLedgerSession, ledgerSessionKey } from './app/ledgerSession'
import { createAppRouter } from './app/router'
import { createSyncSession, startAutoSync, syncSessionKey } from './app/syncSession'
import { sqliteRepository } from './data/sqlite'
import { summarize } from './domain/ledger'
import './shared/styles/base.css'
import { locale, t } from './i18n'

const session = createLedgerSession({ repository: sqliteRepository, calculateMonth: summarize })
const router = createAppRouter(session)
const canRefresh = () => {
  const route = router.currentRoute.value
  return route.name === 'ledger' || route.name === 'statistics' || route.meta.menu === 'settings'
}
const sync = createSyncSession(invoke, session, canRefresh)
const app = createApp(App)
app.provide(ledgerSessionKey, session)
app.provide(syncSessionKey, sync)
app.use(router)
watchEffect(() => {
  document.documentElement.lang = locale.value
  const section = router.currentRoute.value.meta.menu ?? 'ledger'
  document.title = 'SaveMyWallet · ' + t('nav.' + section)
})
void router.isReady().then(() => {
  app.mount('#app')
  if ('__TAURI_INTERNALS__' in window) {
    const stop = startAutoSync(sync, session, canRefresh)
    app.onUnmount(stop)
    if (import.meta.hot) import.meta.hot.dispose(stop)
  }
})
