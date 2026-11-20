<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { useReturnToLedger } from '../../app/navigation'
import { t, formatMoney, formatMonth } from '../../i18n'
import { toCents, type BudgetInput } from '../../domain/ledger'
import '../../shared/styles/ledger-forms.css'

const returnToLedger = useReturnToLedger()
const { data, month, busy, commit, repository, lastPayment, calculateMonth } = useLedgerSession()
const defaultSalary = ref('')
const overrideSalary = ref('')
const floor = ref('')
const invalidAmount = ref(false)

watch([month, () => Boolean(data.value)], ([selectedMonth]) => {
  const ledger = data.value
  if (!ledger) return
  defaultSalary.value = String(ledger.settings.defaultSalaryCents / 100)
  const override = ledger.salaryOverrides[selectedMonth]
  overrideSalary.value = override === undefined ? '' : String(override / 100)
  floor.value = String(ledger.settings.warningFloorCents / 100)
  invalidAmount.value = false
}, { immediate: true })

const parsed = computed<BudgetInput | null>(() => {
  const defaultSalaryCents = toCents(defaultSalary.value)
  const warningFloorCents = toCents(floor.value)
  const hasOverride = overrideSalary.value.trim() !== ''
  const overrideSalaryCents = hasOverride ? toCents(overrideSalary.value) : null
  if (defaultSalaryCents === null || warningFloorCents === null || (hasOverride && overrideSalaryCents === null)) return null
  return { month: month.value, defaultSalaryCents, overrideSalaryCents, warningFloorCents }
})
const monthTotal = computed(() => data.value ? calculateMonth(data.value, month.value).total : null)
const preview = computed(() => {
  if (!parsed.value || monthTotal.value === null) return null
  const salary = parsed.value.overrideSalaryCents ?? parsed.value.defaultSalaryCents
  const balance = salary - monthTotal.value
  return { balance, gap: Math.max(0, parsed.value.warningFloorCents - balance) }
})

function submit() {
  if (busy.value || !data.value) return
  const input = parsed.value
  if (!input) {
    invalidAmount.value = true
    return
  }
  invalidAmount.value = false
  return commit(() => repository.saveBudget(input), () => {
    lastPayment.value = null
    void returnToLedger(t('forms.budgetSaved'))
  })
}
</script>

<template>
  <section v-if="data" class="ledger-editor" aria-labelledby="budget-heading">
    <header class="ledger-form-head">
      <button type="button" class="ledger-back" :aria-label="t('forms.back')" :disabled="busy" @click="returnToLedger()"><ArrowLeft :size="20" /></button>
      <h1 id="budget-heading">{{ t('forms.budget') }}</h1>
    </header>
    <form class="ledger-sheet" novalidate @submit.prevent="submit">
      <div class="ledger-fields">
        <label class="ledger-field"><span>{{ t('forms.defaultSalary') }}</span>
          <input v-model="defaultSalary" name="defaultSalary" inputmode="decimal" required :disabled="busy" />
        </label>
        <label class="ledger-field"><span>{{ t('forms.salaryOverride', { month: formatMonth(month) }) }}</span>
          <input v-model="overrideSalary" name="overrideSalary" inputmode="decimal" :placeholder="t('forms.useDefault')" :disabled="busy" />
          <small class="ledger-hint">{{ t('forms.overrideHint') }}</small>
        </label>
        <label class="ledger-field ledger-wide"><span>{{ t('forms.floor') }}</span>
          <input v-model="floor" name="warningFloor" inputmode="decimal" required :disabled="busy" />
        </label>
      </div>
      <div v-if="preview" class="ledger-summary" :class="{ 'ledger-summary-warning': preview.gap > 0 }" aria-live="polite">
        <TriangleAlert v-if="preview.gap > 0" :size="19" aria-hidden="true" /><ShieldCheck v-else :size="19" aria-hidden="true" />
        <div><strong>{{ t('forms.previewBalance', { month: formatMonth(month), balance: formatMoney(preview.balance) }) }}</strong>
          <p>{{ preview.gap > 0 ? t('forms.belowFloor', { gap: formatMoney(preview.gap) }) : t('forms.meetsFloor') }}</p>
        </div>
      </div>
      <p v-if="invalidAmount" class="ledger-error" role="alert">{{ t('forms.budgetAmountError') }}</p>
      <div class="ledger-form-actions">
        <button type="button" class="ledger-secondary" :disabled="busy" @click="returnToLedger()">{{ t('forms.cancel') }}</button>
        <button type="submit" class="ledger-primary" :disabled="busy">{{ t('forms.saveSettings') }}</button>
      </div>
    </form>
  </section>
</template>
