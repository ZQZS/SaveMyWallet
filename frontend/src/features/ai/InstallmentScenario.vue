<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { MAX_MONTH, MIN_MONTH, type LedgerData } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import { parseScenario } from '../../integrations/ai/deepseek'
import { projectInstallments, readInstallmentTerms, type InstallmentTerms } from './installmentScenario'
import { useAssistantRequest } from './useAssistantRequest'

const props = defineProps<{ month: string; ledger: LedgerData }>()
const router = useRouter()
const message = ref('')
const startMonth = ref(props.month)
const amount = ref('')
const count = ref('')
const extracted = ref(false)
const fieldError = ref('')
const terms = ref<InstallmentTerms | null>(null)
const { run, pending, cancel, error } = useAssistantRequest()
const rows = computed(() => terms.value ? projectInstallments(props.ledger, terms.value) : [])
const warnings = computed(() => rows.value?.filter(row => row.shortfall > 0).length ?? 0)

watch([startMonth, amount, count], () => {
  terms.value = null
  fieldError.value = ''
}, { flush: 'sync' })

function extract() {
  const prompt = message.value.trim()
  if (!prompt) return
  extracted.value = false
  terms.value = null
  fieldError.value = ''
  return run(signal => parseScenario(prompt, props.month, signal), result => {
    startMonth.value = result.startMonth ?? ''
    amount.value = result.amountCents == null ? '' : String(result.amountCents / 100)
    count.value = result.installmentCount == null ? '' : String(result.installmentCount)
    extracted.value = true
  })
}

function simulate() {
  const result = readInstallmentTerms(startMonth.value, amount.value, count.value)
  if ('error' in result) {
    fieldError.value = result.error
    return
  }
  terms.value = result.terms
}

function openBill() {
  if (!terms.value) return
  const { startMonth: month, amountCents, installmentCount } = terms.value
  void router.push({ name: 'bill-create', query: { kind: 'installment', month, amount: String(amountCents / 100), installmentCount } })
}
</script>

<template>
  <div class="planner">
    <form class="extract" @submit.prevent="extract">
      <label class="ledger-field">
        <span>{{ t('ai.month.terms') }}</span>
        <textarea v-model="message" name="scenario-description" rows="2" maxlength="1000" :disabled="pending"
          :placeholder="t('ai.month.questionHint')" />
      </label>
      <p class="ledger-hint">{{ t('ai.month.parseShare', { month: formatMonth(month) }) }}</p>
      <div class="planner-actions">
        <button v-if="pending" class="ledger-secondary" type="button" @click="cancel">{{ t('forms.cancel') }}</button>
        <button v-else class="ledger-secondary" type="submit" :disabled="!message.trim()">{{ t('ai.month.parse') }}</button>
        <span v-if="pending" role="status" class="ledger-hint">{{ t('ai.month.wait') }}</span>
        <RouterLink v-if="error" :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <p v-if="error" class="ledger-error" role="alert">{{ error }}</p>
      <p v-if="extracted" class="ledger-hint" role="status">{{ t('ai.month.review') }}</p>
    </form>
    <form class="terms" novalidate @submit.prevent="simulate">
      <div class="term-fields">
        <label class="ledger-field"><span>{{ t('forms.monthFirst') }}</span>
          <input v-model="startMonth" name="scenario-start" type="month" :min="MIN_MONTH" :max="MAX_MONTH" :disabled="pending" required />
        </label>
        <label class="ledger-field"><span>{{ t('forms.amountPerPeriod') }}</span>
          <input v-model="amount" name="scenario-amount" inputmode="decimal" placeholder="0.00" :disabled="pending" required />
        </label>
        <label class="ledger-field"><span>{{ t('forms.periodCount') }}</span>
          <input v-model="count" name="scenario-count" inputmode="numeric" :disabled="pending" required />
        </label>
      </div>
      <p v-if="fieldError" class="ledger-error" role="alert">{{ t(fieldError) }}</p>
      <div class="planner-actions">
        <button class="ledger-primary" type="submit" :disabled="pending">{{ t('ai.month.simulate') }}</button>
      </div>
    </form>
    <p v-if="terms && !rows" class="ledger-error" role="alert">{{ t('ai.month.rangeError') }}</p>
    <section v-if="terms && rows?.length" class="projection">
      <p role="status">{{ t(warnings ? 'ai.month.risk' : 'ai.month.noRisk', {
        count: warnings, periods: rows.length, floor: formatMoney(ledger.settings.warningFloorCents) }) }}</p>
      <div role="region" tabindex="0" :aria-label="t('ai.month.forecast')" class="table-wrap">
        <table :aria-label="t('ai.month.forecast')">
          <thead><tr>
            <th scope="col">{{ t('ai.month.period') }}</th>
            <th scope="col">{{ t('ai.month.original') }}</th>
            <th scope="col">{{ t('ai.month.projected') }}</th>
          </tr></thead>
          <tbody><tr v-for="row in rows" :key="row.month">
            <th scope="row">{{ formatMonth(row.month) }}</th>
            <td>{{ formatMoney(row.before) }}</td>
            <td>{{ formatMoney(row.after) }}
              <small v-if="row.shortfall">{{ t('ledger.belowFloor', { amount: formatMoney(row.shortfall) }) }}</small>
            </td>
          </tr></tbody>
        </table>
      </div>
      <div class="planner-actions"><button type="button" class="ledger-secondary" @click="openBill">{{ t('ai.month.openBill') }}</button></div>
    </section>
  </div>
</template>

<style scoped>
.planner, .extract, .terms, .projection { display: grid; min-width: 0; gap: 12px; }
.terms { border-top: 1px solid var(--line); padding-top: 16px; }
.term-fields { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, .8fr); gap: 12px; }
.planner textarea { resize: vertical; min-height: 64px; padding: 10px 12px; font: inherit; font-weight: 400; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--paper); }
.planner textarea:focus-visible, .table-wrap:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.planner-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.planner-actions a { color: var(--green); font-size: .875rem; }
.projection > p { font-weight: 600; }
.table-wrap { max-height: 24rem; overflow-y: auto; }
table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; font-size: .875rem; font-variant-numeric: tabular-nums; }
td, th { padding: 7px 6px; text-align: right; overflow-wrap: anywhere; border-bottom: 1px solid var(--line); }
th:first-child { text-align: left; }
thead th { position: sticky; top: 0; background: var(--soft); color: var(--green); }
td small { display: block; color: var(--warning-ink); }
@media (max-width: 600px) { .term-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .term-fields > :first-child { grid-column: 1 / -1; } }
</style>
