import { computed, inject, ref, shallowRef, type InjectionKey } from 'vue'
import type { LedgerRepository } from '../data/repository'
import { currentMonth, isMonth, projectBillingMonths, summarizePlatforms, type LedgerData, type summarize } from '../domain/ledger.ts'
import { displayError, t } from '../i18n/index.ts'

interface LedgerServices {
  repository: LedgerRepository
  calculateMonth: typeof summarize
}

interface PaymentChange {
  month: string
  ids: string[]
  paid: boolean
}

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

  return { repository, calculateMonth, data, platformSummaries, calendarMonth, month, busy, needsReload, writeCount, error, notice, lastPayment, selectMonth, updateCalendarMonth, retryRead, commit }
}

export type LedgerSession = ReturnType<typeof createLedgerSession>
export const ledgerSessionKey: InjectionKey<LedgerSession> = Symbol('ledgerSession')

export function useLedgerSession(): LedgerSession {
  const session = inject(ledgerSessionKey)
  if (!session) throw new Error('缺少账本会话，请检查应用入口。')
  return session
}
