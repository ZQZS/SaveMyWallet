<script setup lang="ts">
import { computed } from 'vue'
import type { PlatformSummary } from '../../../domain/ledger'
import { formatMoney, t } from '../../../i18n'

const props = defineProps<{ summary: PlatformSummary }>()
const metrics = computed(() => [
  { label: 'forms.repaymentTotal', amount: props.summary.total, count: props.summary.entryCount },
  { label: 'ledger.paid', amount: props.summary.paid, count: props.summary.paidCount },
  { label: 'forms.confirmedDue', amount: props.summary.due, count: props.summary.dueCount },
  { label: 'ledger.needsConfirmation', amount: props.summary.estimated, count: props.summary.estimatedCount },
])
</script>

<template>
  <div class="platform-summary">
    <dl>
      <div v-for="metric in metrics" :key="metric.label">
        <dt>{{ t(metric.label) }}</dt>
        <dd>
          <strong>{{ formatMoney(metric.amount) }}</strong>
          <small>{{ t('forms.entryCount', { count: metric.count }) }}</small>
        </dd>
      </div>
    </dl>
    <p v-if="summary.voidedCount" class="ledger-hint">{{ t('forms.voidedSummary', { count: summary.voidedCount }) }}</p>
  </div>
</template>

<style scoped>
.platform-summary { display: grid; gap: 8px; }
dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}
dt, small { color: var(--sub); font-size: .8rem; }
dd { display: grid; gap: 2px; margin: 3px 0 0; font-variant-numeric: tabular-nums; }
strong { overflow-wrap: anywhere; }
dl > :first-child strong { color: var(--green); }
@media (max-width: 540px) {
  dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
