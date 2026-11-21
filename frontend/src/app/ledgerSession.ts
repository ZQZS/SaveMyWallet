import { computed, inject, ref, shallowRef, type InjectionKey } from 'vue'
import type { LedgerRepository } from '../data/repository'
import { currentMonth, isMonth, projectBillingMonths, summarizePlatforms, type LedgerData, type summarize } from '../domain/ledger.ts'
import { displayError, formatMoney, t } from '../i18n/index.ts'

interface LedgerServices {
  repository: LedgerRepository
  calculateMonth: typeof summarize
}

type PaymentScope = { month: string; platformId?: never } | { platformId: string; month?: never }
type PaymentChange = PaymentScope & { ids: string[]; paid: boolean }

export function createLedgerSession({ repository, calculateMonth }: LedgerServices) {
  const snapshot = shallowRef<LedgerData | null>(null)
  const calendarMonth = ref(currentMonth())
  const data = computed(() => snapshot.value && projectBillingMonths(snapshot.value, calendarMonth.value))
  const platformSummaries = computed(() => data.value ? summarizePlatforms(data.value) : null)
  const month = ref(calendarMonth.value)
  const busy = ref(false)
  const needsReload = ref(false)
  const writeCount = ref(0)
  const error = ref('')
  const notice = ref('')
  const lastPayment = ref<PaymentChange | null>(null)
  let pendingPayment: { signature: string; operationId: string; ids: string[] } | undefined
  let afterRefresh: (() => void) | undefined

  function selectMonth(value: string) {
    if (!isMonth(value)) return
    month.value = value
    lastPayment.value = null
    notice.value = ''
  }

  function updateCalendarMonth(value: string, followCurrentMonth: boolean) {
    if (value === calendarMonth.value || !isMonth(value)) return
    const wasCurrent = month.value === calendarMonth.value
    calendarMonth.value = value
    if (followCurrentMonth && wasCurrent && !busy.value && !needsReload.value) selectMonth(value)
  }

  async function readSnapshot() {
    try {
      snapshot.value = await repository.load()
      needsReload.value = false
      error.value = ''
    } catch (cause) {
      needsReload.value = true
      const reason = displayError(cause)
      error.value = afterRefresh ? t('app.readAfterWrite', { reason }) : reason
      return
    } finally {
      busy.value = false
    }
    const complete = afterRefresh
    afterRefresh = undefined
    complete?.()
  }

  async function retryRead() {
    if (busy.value) return
    busy.value = true
    await readSnapshot()
  }

  // If a write succeeds and the subsequent read fails, retry only the read.
  async function commit<T>(write: () => Promise<T>, finish: (result: T) => void) {
    if (busy.value || needsReload.value) return
    busy.value = true
    error.value = ''
    try {
      const result = await write()
      writeCount.value++
      afterRefresh = () => finish(result)
    } catch (cause) {
      error.value = displayError(cause)
      busy.value = false
      return
    }
    await readSnapshot()
  }

  function markPayments(ids: string[], paid: boolean, scope: PaymentScope, onSaved?: (changedIds: string[]) => void) {
    return commit(() => {
      const signature = JSON.stringify([scope.month, scope.platformId, paid, [...new Set(ids)].sort()])
      if (pendingPayment?.signature !== signature) {
        pendingPayment = { signature, operationId: crypto.randomUUID(), ids: [...ids] }
      }
      // REST fingerprints the request body as well as the key, including the original ID order.
      return repository.setPayment(pendingPayment.ids, paid, pendingPayment.operationId)
    }, changed => {
      pendingPayment = undefined
      if (changed.length) {
        lastPayment.value = { ...scope, ids: changed, paid }
        const changedIds = new Set(changed)
        const amount = data.value!.entries.reduce((sum, entry) => sum + (changedIds.has(entry.id) ? entry.amountCents : 0), 0)
        notice.value = t(paid ? 'ledger.markedPaid' : 'ledger.markedDue', { count: changed.length, amount: formatMoney(amount) })
      } else {
        notice.value = t('ledger.updated')
      }
      onSaved?.(changed)
    })
  }

  function undoPayment() {
    const action = lastPayment.value
    if (!action) return
    return commit(() => repository.undoPayment
      ? repository.undoPayment(action.ids, !action.paid)
      : repository.setPayment(action.ids, !action.paid), changed => {
      lastPayment.value = null
      notice.value = t(changed.length ? 'ledger.paymentUndone' : 'ledger.updated')
    })
  }

  function invalidatePaymentUndo(changed: string[]) {
    const payment = lastPayment.value
    if (!payment || !changed.length) return
    const changedIds = new Set(changed)
    const ids = payment.ids.filter(id => !changedIds.has(id))
    if (ids.length !== payment.ids.length) lastPayment.value = ids.length ? { ...payment, ids } : null
  }

  function reconcilePaymentUndo() {
    const payment = lastPayment.value
    if (!payment || !snapshot.value) return
    const status = payment.paid ? 'paid' : 'due'
    const unavailable = new Set(payment.ids)
    for (const entry of snapshot.value.entries) {
      if (!entry.voided && entry.amountCents > 0 && entry.status === status) unavailable.delete(entry.id)
      if (!unavailable.size) break
    }
    if (unavailable.size) invalidatePaymentUndo([...unavailable])
  }

  return { repository, calculateMonth, data, platformSummaries, calendarMonth, month, busy, needsReload, writeCount,
    error, notice, lastPayment, selectMonth, updateCalendarMonth, retryRead, commit, markPayments, undoPayment, invalidatePaymentUndo, reconcilePaymentUndo }
}

export type LedgerSession = ReturnType<typeof createLedgerSession>
export const ledgerSessionKey: InjectionKey<LedgerSession> = Symbol('ledgerSession')

export function useLedgerSession(): LedgerSession {
  const session = inject(ledgerSessionKey)
  if (!session) throw new Error('缺少账本会话，请检查应用入口。')
  return session
}
