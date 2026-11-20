<script setup lang="ts">
import { ArrowUpRight } from 'lucide-vue-next'
import type { MonthlySummary } from '../../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../../i18n'

defineProps<{ month: string; totals: MonthlySummary; floor: number; busy: boolean }>()
const emit = defineEmits<{ open: [month: string] }>()
</script>

<template>
  <button type="button" class="next-month" :disabled="busy"
    @click="emit('open', month)">
    <span class="next-description">
      <strong>{{ t('ledger.nextForecast', { month: formatMonth(month) }) }}</strong>
      <small>{{ t('ledger.projectedSpending', { amount: formatMoney(totals.total) }) }}<span v-if="totals.balance < floor" class="low">{{ t('ledger.shortfall', { amount: formatMoney(floor - totals.balance) }) }}</span></small>
    </span>
    <span class="next-balance">{{ t('ledger.balance') }} <strong>{{ formatMoney(totals.balance) }}</strong></span>
    <ArrowUpRight :size="17" aria-hidden="true" />
  </button>
</template>

<style scoped>
.next-description small { color: var(--sub); font-size: 0.8rem; }
.next-month:disabled { cursor: default; opacity: 0.55; }
.next-month {
  width: 100%; display: flex; align-items: center; gap: 12px; padding: 15px 20px; text-align: left;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 13px;
}
.next-month:hover:not(:disabled) { border-color: var(--green); }
.next-description { flex: 1; display: grid; min-width: 0; gap: 3px; }
.next-description strong, .next-balance strong { font-weight: 650; }
.low { display: inline-block; color: #865418; }
.next-balance { text-align: right; font-size: 0.88rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.next-month > svg { flex: none; color: var(--green); }
@media (max-width: 650px) {
  .next-month { padding: 12px; gap: 7px; }
  .next-balance { max-width: 36%; }
  .next-balance strong { display: block; }
}
</style>
