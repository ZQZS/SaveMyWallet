<script setup lang="ts">
import { computed } from 'vue'
import { estimateTotalCents, type Entry } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'

const props = defineProps<{ entry: Entry }>()
const description = computed(() => {
  const { entry } = props
  if (entry.kind === 'installment') {
    return t('ledger.installment', { index: entry.installmentIndex ?? '—', count: entry.installmentCount ?? '—' })
  }
  if (entry.kind === 'estimate') return t(entry.status === 'estimated' ? 'ledger.estimate' : 'ledger.confirmedEstimate')
  return t('ledger.singlePayment')
})
</script>

<template>
  <span class="entry-title">
    <strong :class="{ voided: entry.voided }">{{ entry.title }}</strong>
    <small>{{ description }}<template v-if="entry.carriedFromMonth"> · {{ t('ledger.originalEstimateMonth', {
      month: formatMonth(entry.carriedFromMonth),
    }) }}</template></small>
    <small v-if="entry.kind === 'estimate'">{{ t('ledger.estimateBreakdown', {
      total: formatMoney(estimateTotalCents(entry)), deposit: formatMoney(entry.depositCents ?? 0),
    }) }}</small>
  </span>
</template>

<style scoped>
.entry-title { display: grid; min-width: 0; gap: 3px; overflow-wrap: anywhere; }
strong { font-weight: 650; }
small { color: var(--sub); font-size: .78rem; }
.voided { color: var(--sub); text-decoration: line-through; }
</style>
