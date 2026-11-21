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
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr);
  border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
}
.balance {
  --focus-ring: var(--hero-ink);
  min-width: 0; display: grid; align-content: center; justify-items: start;
  padding: clamp(22px, 2.9vw, 36px); background: var(--hero-bg); color: var(--hero-ink);
}
.balance-label { display: block; font-size: 0.9rem; font-weight: 550; }
.balance-amount {
  display: block; font-size: clamp(2.2rem, 4.5vw, 3.45rem); font-variant-numeric: tabular-nums;
  font-weight: 650; line-height: 1.12; letter-spacing: -0.055em; margin: 6px 0; overflow-wrap: anywhere;
}
.threshold {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 0; border: 0;
  background: transparent; color: inherit; font-size: 0.8rem; text-align: left;
}
.threshold:hover { text-decoration: underline; text-underline-offset: 3px; }
.threshold.warning { padding-inline: 8px; border-radius: 6px; color: var(--warning-ink); background: var(--warning-bg); }
.metrics {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-content: center;
  padding: 20px clamp(4px, 1.25vw, 18px); color: var(--ink);
  background-color: var(--surface); background-image: var(--page-background-image, none);
  background-size: var(--page-background-size, auto); background-position: center;
}
.metric { min-width: 0; padding: 3px clamp(8px, 1.1vw, 16px); }
.metric + .metric { border-left: 1px solid var(--line); }
.metric dt, .metric small { display: block; color: var(--sub); font-size: 0.8rem; }
.metric dd { padding-block: 4px; font-size: clamp(1.1rem, 2.1vw, 1.55rem); line-height: 1.3; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
@media (max-width: 650px) {
  .summary { grid-template-columns: 1fr; }
  .balance { padding: 16px; }
  .balance-amount { font-size: 2.5rem; }
  .metrics { padding: 12px 16px; }
  .metric { padding: 0 8px; }
  .metric:first-child { padding-left: 0; }
  .metric:last-child { padding-right: 0; }
  .metric dd { font-size: 1.12rem; }
  .metric small { font-size: 0.74rem; }
}
@media (pointer: coarse) {
  .threshold { min-height: 40px; }
}
</style>
