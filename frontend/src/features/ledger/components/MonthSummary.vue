<script setup lang="ts">
import { ChevronRight, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import type { MonthlySummary } from '../../../domain/ledger'
import { formatMoney, t } from '../../../i18n'

defineProps<{ totals: MonthlySummary; floor: number; hasOverride: boolean; busy: boolean }>()
const emit = defineEmits<{ budget: [] }>()
</script>

<template>
  <section class="summary" :aria-label="t('ledger.forecast')">
    <div class="balance">
      <span class="balance-label">{{ t('ledger.balance') }}</span>
      <strong class="balance-amount">{{ formatMoney(totals.balance) }}</strong>
      <button class="threshold" :class="{ warning: totals.balance < floor }" type="button"
        :disabled="busy" @click="emit('budget')">
        <TriangleAlert v-if="totals.balance < floor" :size="15" aria-hidden="true" />
        <ShieldCheck v-else :size="15" aria-hidden="true" />
        <span v-if="totals.balance < floor">{{ t('ledger.belowFloor', { amount: formatMoney(floor - totals.balance) }) }}</span>
        <span v-else>{{ t('ledger.floor', { amount: formatMoney(floor) }) }}</span>
        <ChevronRight :size="13" aria-hidden="true" />
      </button>
    </div>
    <dl class="metrics">
      <div class="metric"><dt>{{ t('ledger.salary') }}</dt><dd>{{ formatMoney(totals.salary) }}</dd>
        <small>{{ t(hasOverride ? 'ledger.monthOverride' : 'ledger.defaultSalary') }}</small></div>
      <div class="metric"><dt>{{ t('ledger.total') }}</dt><dd>{{ formatMoney(totals.total) }}</dd>
        <small>{{ t('ledger.includesEstimates', { amount: formatMoney(totals.estimated) }) }}</small></div>
      <div class="metric"><dt>{{ t('ledger.outstanding') }}</dt><dd>{{ formatMoney(totals.due) }}</dd>
        <small>{{ t('ledger.confirmedUnpaid') }}</small></div>
    </dl>
  </section>
</template>

<style scoped>
.summary dl, .summary dd { margin: 0; }
.threshold:disabled { cursor: default; opacity: 0.55; }
.summary {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr); align-items: center;
  gap: clamp(15px, 3vw, 36px); padding: clamp(22px, 2.9vw, 36px);
  border-radius: 16px; overflow: hidden;
  background-color: #184c38;
  background-image: radial-gradient(95% 225% at 110% 115%, #86b77b26 0 29%, transparent 29.6% 36%, #86b77b16 36.5% 47%, transparent 47.5%);
  color: #f4faed;
}
.balance { min-width: 0; }
.balance-label { display: block; font-size: 0.9rem; color: #d4e4d6; font-weight: 550; }
.balance-amount {
  display: block; font-size: clamp(2.2rem, 4.5vw, 3.45rem); font-variant-numeric: tabular-nums;
  font-weight: 650; line-height: 1.12; letter-spacing: -0.055em; margin: 6px 0; overflow-wrap: anywhere;
}
.threshold {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 0; border: 0;
  background: transparent; color: #d4e4d6; font-size: 0.8rem; text-align: left;
}
.threshold:hover { text-decoration: underline; text-underline-offset: 3px; }
.threshold.warning { color: #ffe3a1; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.metric { min-width: 0; padding: 3px clamp(9px, 1.4vw, 21px); border-left: 1px solid #c1d7c44d; }
.metric dt, .metric small { display: block; color: #d3e2d5; font-size: 0.8rem; }
.metric dd { padding-block: 4px; font-size: clamp(1.1rem, 2.1vw, 1.55rem); line-height: 1.3; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@media (max-width: 650px) {
  .summary { grid-template-columns: 1fr; gap: 14px; padding: 18px 16px; }
  .balance-amount { font-size: 2.5rem; }
  .metrics { padding-top: 12px; border-top: 1px solid #c1d7c44d; }
  .metric { padding: 0 8px; }
  .metric:first-child { padding-left: 0; border-left: 0; }
  .metric:last-child { padding-right: 0; }
  .metric dd { font-size: 1.12rem; }
  .metric small { font-size: 0.74rem; }
}
@media (pointer: coarse) {
  .threshold { min-height: 40px; }
}
</style>
