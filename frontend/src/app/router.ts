import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import LedgerPage from '../features/ledger/LedgerPage.vue'
import BillPage from '../features/bills/BillPage.vue'
import PlatformsPage from '../features/platforms/PlatformsPage.vue'
import BudgetPage from '../features/budget/BudgetPage.vue'
import { settingsRoutes } from '../features/settings/settingsRoutes'
import type { LedgerSession } from './ledgerSession'
import type { MenuName } from './menu'

declare module 'vue-router' {
  interface RouteMeta { menu?: MenuName }
}

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: { name: 'ledger' } },
  { path: '/ledger', name: 'ledger', component: LedgerPage, meta: { menu: 'ledger' } },
  { path: '/bills/new', name: 'bill-create', component: BillPage, meta: { menu: 'ledger' } },
  { path: '/bills/:id/confirm', name: 'bill-confirm', component: BillPage, meta: { menu: 'ledger' } },
  { path: '/platforms', name: 'platforms', component: PlatformsPage, meta: { menu: 'platforms' } },
  { path: '/budget', name: 'budget', component: BudgetPage, meta: { menu: 'budget' } },
  { path: '/settings', meta: { menu: 'settings' }, children: settingsRoutes },
  { path: '/:pathMatch(.*)*', redirect: { name: 'ledger' } },
]

export function createAppRouter(session: LedgerSession) {
  const router = createRouter({
    history: createWebHashHistory(),
    routes,
    scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
  })
  router.beforeEach((_to, from) => {
    if (from.name && (session.busy.value || session.needsReload.value)) return false
  })
  router.afterEach((_to, _from, failure) => {
    if (!failure) {
      session.error.value = ''
      session.notice.value = ''
    }
  })
  return router
}
