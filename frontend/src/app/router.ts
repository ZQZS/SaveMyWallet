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
  { path: '/ledger/reconcile', name: 'notice-reconcile', component: () => import('../features/ai/NoticeReconciliation.vue'), meta: { menu: 'ledger' } },
  { path: '/ledger/search', name: 'ledger-search', component: () => import('../features/ai/LedgerSearch.vue'), meta: { menu: 'ledger' } },
  { path: '/bills/new', name: 'bill-create', component: BillPage, meta: { menu: 'ledger' } },
  { path: '/bills/:id/confirm', name: 'bill-confirm', component: BillPage, meta: { menu: 'ledger' } },
  { path: '/platforms', name: 'platforms', component: PlatformsPage, meta: { menu: 'platforms' } },
  { path: '/platforms/:id', name: 'platform-details', component: () => import('../features/platforms/PlatformDetailsPage.vue'), props: true, meta: { menu: 'platforms' } },
  { path: '/statistics', name: 'statistics', component: () => import('../features/statistics/StatisticsPage.vue'), meta: { menu: 'statistics' } },
  { path: '/budget', name: 'budget', component: BudgetPage, meta: { menu: 'budget' } },
  { path: '/chat', name: 'chat', component: () => import('../features/ai/ChatPage.vue'), meta: { menu: 'chat' } },
  { path: '/settings', meta: { menu: 'settings' }, children: settingsRoutes },
  { path: '/:pathMatch(.*)*', redirect: { name: 'ledger' } },
]

export function createAppRouter(session: LedgerSession) {
  const router = createRouter({
    history: createWebHashHistory(),
    routes,
    scrollBehavior: (to, from, saved) => {
      if (to.name === 'ledger' && typeof to.query.entry === 'string') return false
      if (to.name === 'statistics' && from.name === 'statistics') return false
      return saved ?? { top: 0 }
    },
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
