import { computed, inject, ref, shallowRef, watch, type InjectionKey } from 'vue'
import type { LedgerSession } from './ledgerSession.ts'
import type { ConflictChoice, SyncPreview, SyncStatus } from '../features/settings/sync/syncTypes.ts'
import { displayError } from '../i18n/index.ts'

type SyncInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export function createSyncSession(invoke: SyncInvoke, ledger: LedgerSession, canRefresh: () => boolean) {
  const status = shallowRef<SyncStatus | null>(null)
  const action = ref('')
  const error = ref('')
  const busy = computed(() => Boolean(action.value))
  let needsSnapshot = false

  // Remote data can arrive while a form is open or a local write is awaiting a read retry.
  // Keep that draft mounted and let the normal ledger reader handle the next safe refresh.
  async function refreshLedger() {
    if (!needsSnapshot || !canRefresh() || ledger.busy.value || ledger.needsReload.value) return
    needsSnapshot = false
    await ledger.retryRead()
  }

  async function receive(command: string, args?: Record<string, unknown>) {
    const priorPayment = ledger.lastPayment.value
    const next = await invoke<SyncStatus>(command, args)
    status.value = next
    if (priorPayment && priorPayment === ledger.lastPayment.value) {
      if (command === 'sync_bind' || command === 'sync_disconnect') {
        ledger.lastPayment.value = null
      } else if (next.bound) {
        // A server no-op or a later payment by another device can revoke just part of a batch.
        const owned = new Set(next.undoableIds)
        const ids = priorPayment.ids.filter(id => owned.has(id))
        if (ids.length !== priorPayment.ids.length) ledger.lastPayment.value = ids.length ? { ...priorPayment, ids } : null
      }
    }
    return next
  }

  async function perform<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return
    action.value = name
    error.value = ''
    try {
      return await work()
    } catch (cause) {
      error.value = displayError(cause)
      // A failed network request can still follow a committed local bind, ack or pull.
      try { await receive('sync_status') } catch { /* Keep the original error for the user. */ }
    } finally {
      action.value = ''
      await refreshLedger()
    }
  }

  async function change(command: string, args?: Record<string, unknown>) {
    return perform(command, async () => {
      try {
        return await receive(command, args)
      } finally {
        needsSnapshot = true
      }
    })
  }

  return {
    status, action, error, busy, refreshLedger,
    load: () => perform('sync_status', () => receive('sync_status')),
    preview: (url: string, token: string) => perform('sync_preview', () => invoke<SyncPreview>('sync_preview', { url, token })),
    bind: (url: string, token: string, preview: SyncPreview) =>
      change('sync_bind', { url, token, ledgerId: preview.ledgerId, cursor: preview.cursor }),
    authenticate: (token: string) => change('sync_authenticate', { token }),
    run: () => change('sync_run'),
    resolve: (operationId: string, choice: ConflictChoice) => change('sync_resolve', { operationId, choice }),
    disconnect: () => change('sync_disconnect'),
  }
}

export type SyncSession = ReturnType<typeof createSyncSession>
export const syncSessionKey: InjectionKey<SyncSession> = Symbol('syncSession')
export function useSyncSession(): SyncSession {
  const session = inject(syncSessionKey)
  if (!session) throw new Error('Missing sync session')
  return session
}

export function startAutoSync(sync: SyncSession, ledger: LedgerSession, canRefresh: () => boolean) {
  let timer: ReturnType<typeof setTimeout>
  let queued = false
  let stopped = false

  async function synchronize() {
    if (stopped || !queued || document.hidden || !canRefresh() || sync.busy.value || ledger.busy.value || ledger.needsReload.value) return
    queued = false
    // Read local state even when offline, so the settings page shows current pending work.
    await sync.load()
    if (!stopped && navigator.onLine && sync.status.value?.authenticated && sync.status.value.bound && canRefresh()) {
      await sync.run()
    }
  }
  function schedule() {
    queued = true
    clearTimeout(timer)
    timer = setTimeout(() => { void synchronize() }, 600)
  }
  const stopWrites = watch(ledger.writeCount, schedule)
  const stopRecovery = watch([sync.busy, ledger.busy, ledger.needsReload, canRefresh], () => {
    void sync.refreshLedger()
    if (queued) schedule()
  })
  const tick = setInterval(schedule, 60_000)
  window.addEventListener('online', schedule)
  document.addEventListener('visibilitychange', schedule)
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
    clearInterval(tick)
    window.removeEventListener('online', schedule)
    document.removeEventListener('visibilitychange', schedule)
    stopWrites()
    stopRecovery()
  }
}
