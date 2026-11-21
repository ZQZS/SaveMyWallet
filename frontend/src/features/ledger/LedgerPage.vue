<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronLeft, ChevronRight, Plus, Undo2 } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { currentMonth, installmentPeriods, MAX_MONTH, MIN_MONTH, shiftMonth, type Entry } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import MonthlyLedger from './components/MonthlyLedger.vue'
import MonthSummary from './components/MonthSummary.vue'
import NextMonthPreview from './components/NextMonthPreview.vue'
import InstallmentScopeDialog from './components/InstallmentScopeDialog.vue'
import MonthlyAssistant from '../ai/MonthlyAssistant.vue'

const router = useRouter()
const { data, month, busy, notice, lastPayment, selectMonth, commit, repository, calculateMonth } = useLedgerSession()
const totals = computed(() => data.value && calculateMonth(data.value, month.value))
const nextMonth = computed(() => month.value < MAX_MONTH ? shiftMonth(month.value, 1) : null)
const nextTotals = computed(() => data.value && nextMonth.value ? calculateMonth(data.value, nextMonth.value) : null)
const selectedEntryId = ref<string | null>(null)
const selectedPeriod = computed(() => selectedEntryId.value
  ? data.value?.entries.find(entry => entry.id === selectedEntryId.value && entry.month === month.value)
  : null)
const selectedPlan = computed(() => selectedPeriod.value && data.value
  ? installmentPeriods(data.value.entries, selectedPeriod.value) : null)

function markPayments(ids: string[], paid: boolean) {
  return commit(() => repository.setPayment(ids, paid), changed => {
    if (!changed.length) {
      lastPayment.value = null
      notice.value = t('ledger.updated')
      return
    }

    lastPayment.value = { month: month.value, ids: changed, paid }
    const changedIds = new Set(changed)
    const amount = data.value!.entries.reduce((sum, entry) => sum + (changedIds.has(entry.id) ? entry.amountCents : 0), 0)
    notice.value = t(paid ? 'ledger.markedPaid' : 'ledger.markedDue', { count: changed.length, amount: formatMoney(amount) })
  })
}

function undoPayment() {
  const action = lastPayment.value
  if (!action || action.month !== month.value) return
  return commit(() => repository.undoPayment
    ? repository.undoPayment(action.ids, !action.paid)
    : repository.setPayment(action.ids, !action.paid), changed => {
    lastPayment.value = null
    notice.value = t(changed.length ? 'ledger.paymentUndone' : 'ledger.updated')
  })
}

function chooseVoidScope(entry: Entry, voided: boolean) {
  if (entry.kind === 'installment') selectedEntryId.value = entry.id
  else applyVoided(entry, voided, false)
}

function applyVoided(entry: Entry, voided: boolean, whole: boolean) {
  return commit(async () => {
    if (whole) return repository.setInstallmentVoided(entry.id, voided)
    await repository.setEntryVoided(entry.id, voided)
    return [entry.id]
  }, changed => {
    const payment = lastPayment.value
    if (payment) {
      const changedIds = new Set(changed)
      const ids = payment.ids.filter(id => !changedIds.has(id))
      if (ids.length !== payment.ids.length) lastPayment.value = ids.length ? { ...payment, ids } : null
    }
    const message = whole
      ? (voided ? 'ledger.planVoidedNotice' : 'ledger.planRestoredNotice')
      : (voided ? 'ledger.voidedNotice' : 'ledger.restoredNotice')
    notice.value = changed.length ? t(message, { title: entry.title, count: changed.length }) : t('ledger.updated')
  })
}
</script>

<template>
  <div v-if="data && totals" class="monthly-ledger" :aria-busy="busy">
    <div class="month-heading">
      <div class="month-period">
        <h1>{{ formatMonth(month) }}</h1>
        <div class="month-controls" role="group" :aria-label="t('ledger.monthNavigation')">
          <button type="button" :aria-label="t('ledger.previousMonth')" :disabled="busy || month <= MIN_MONTH"
            @click="selectMonth(shiftMonth(month, -1))"><ChevronLeft :size="16" aria-hidden="true" /></button>
          <button type="button" :disabled="busy" @click="selectMonth(currentMonth())">{{ t('ledger.currentMonth') }}</button>
          <button type="button" :aria-label="t('ledger.nextMonth')" :disabled="busy || !nextMonth"
            @click="nextMonth && selectMonth(nextMonth)"><ChevronRight :size="16" aria-hidden="true" /></button>
        </div>
      </div>
      <button class="add-button" type="button" :disabled="busy" @click="router.push({ name: 'bill-create' })">
        <Plus :size="17" aria-hidden="true" />{{ t('ledger.addBill') }}
      </button>
    </div>

    <MonthSummary :totals="totals" :floor="data.settings.warningFloorCents"
      :has-override="data.salaryOverrides[month] !== undefined" :busy="busy"
      @budget="router.push({ name: 'budget' })" />

    <MonthlyAssistant :key="month" :month="month" :ledger="data" :summary="totals" />

    <MonthlyLedger :key="month" :groups="totals.groups" :paid="totals.paid" :busy="busy"
      @pay="markPayments" @set-voided="chooseVoidScope" @confirm="router.push({ name: 'bill-confirm', params: { id: $event.id } })" />

    <InstallmentScopeDialog v-if="selectedPeriod" :entry="selectedPeriod" :periods="selectedPlan" :busy="busy"
      @apply="applyVoided" @dismiss="selectedEntryId = null" />

    <div v-if="notice || lastPayment?.month === month" class="notice">
      <span role="status">{{ notice }}</span>
      <button v-if="lastPayment?.month === month" type="button" :disabled="busy" @click="undoPayment">
        <Undo2 :size="15" aria-hidden="true" />{{ t('ledger.undo') }}
      </button>
    </div>

    <NextMonthPreview v-if="nextMonth && nextTotals" :month="nextMonth" :totals="nextTotals"
      :floor="data.settings.warningFloorCents" :busy="busy" @open="selectMonth" />
  </div>
</template>

<style scoped>
.monthly-ledger { display: grid; min-width: 0; gap: 20px; color: var(--ink); }
.monthly-ledger h1 { margin: 0; }
.monthly-ledger button { font-family: inherit; cursor: pointer; }
.monthly-ledger button:disabled { cursor: default; opacity: 0.55; }
.month-heading, .month-period, .month-controls, .notice { display: flex; align-items: center; }
.month-heading, .notice { justify-content: space-between; gap: 12px; }
.month-period { gap: 14px; flex-wrap: wrap; min-width: 0; }
.month-heading h1 { font-size: clamp(1.48rem, 3vw, 2rem); letter-spacing: -0.045em; line-height: 1.22; }
.month-controls { background: var(--surface); padding: 1px; border: 1px solid var(--line); border-radius: 10px; }
.month-controls button {
  display: grid; place-items: center; min-width: 32px; min-height: 32px;
  border: 0; border-radius: 7px; background: transparent; color: var(--sub); font-size: 0.8rem;
}
.month-controls button:hover:not(:disabled) { color: var(--green); background: var(--soft); }
.add-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  border: 1px solid #184d39; border-radius: 10px; min-height: 41px; padding: 8px 16px;
  color: #fffef6; background: #184d39; font-weight: 650; white-space: nowrap;
}
.add-button:hover:not(:disabled) { background: #103b2b; }
.notice { border-radius: 10px; background: var(--soft); padding: 6px 14px; min-height: 44px; font-size: 0.88rem; }
.notice [role="status"] { min-width: 0; overflow-wrap: anywhere; }
.notice button { display: inline-flex; align-items: center; gap: 5px; flex: none; background: transparent; border: 0; color: var(--green); min-height: 40px; font-weight: 650; }
@media (max-width: 650px) {
  .monthly-ledger { gap: 14px; }
  .month-heading { align-items: flex-start; }
  .month-period { gap: 8px; }
  .add-button { min-height: 44px; padding-inline: 12px; }
}
@media (max-width: 450px) {
  .month-period { display: grid; justify-items: start; }
}
@media (pointer: coarse) {
  .month-controls button { min-height: 44px; min-width: 40px; }
}
</style>
