<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import { classifySpendingTitles } from '../../integrations/ai/deepseek'
import { useAssistantRequest } from '../ai/useAssistantRequest'
import type { StatisticsMonth } from './statistics'
import { analyzeCategorySpending, prepareCategorySpending, type CategorySpendingRow } from './spendingCategories'

const props = defineProps<{ points: StatisticsMonth[]; selectedMonth: string }>()
const scopes = ['period', 'month'] as const
const scope = ref<typeof scopes[number]>('period')
const previewOpen = ref(false)
const months = computed(() => scope.value === 'period' ? props.points : props.points.filter(point => point.month === props.selectedMonth))
const firstMonth = computed(() => months.value[0]?.month)
const lastMonth = computed(() => months.value.at(-1)?.month)
const input = computed(() => prepareCategorySpending(months.value))
const rows = shallowRef<CategorySpendingRow[] | null>(null)
const { pending, error, run, cancel } = useAssistantRequest()
const percent = computed(() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 1 }))

// Identical sync snapshots keep the result. A changed range or set of expenses invalidates it.
watch(() => JSON.stringify([firstMonth.value, lastMonth.value, input.value]), () => {
  cancel()
  rows.value = null
})

function analyze() {
  if (!input.value.count || pending.value) return
  const snapshot = input.value
  return run(signal => analyzeCategorySpending(snapshot, classifySpendingTitles, signal), result => { rows.value = result })
}
</script>

<template>
  <section class="analysis" aria-labelledby="spending-analysis-heading">
    <header>
      <h2 id="spending-analysis-heading"><Sparkles :size="19" aria-hidden="true" />{{ t('stats.ai.title') }}</h2>
      <div class="scope" role="group" :aria-label="t('stats.ai.scope')">
        <button v-for="choice in scopes" :key="choice" type="button" :aria-pressed="scope === choice"
          @click="scope = choice">{{ t('stats.ai.' + choice) }}</button>
      </div>
    </header>
    <p v-if="firstMonth && lastMonth" class="coverage">
      <time :datetime="firstMonth">{{ formatMonth(firstMonth) }}</time><template v-if="firstMonth !== lastMonth">
        – <time :datetime="lastMonth">{{ formatMonth(lastMonth) }}</time></template>
      · {{ t('stats.ai.coverage', { count: input.count, amount: formatMoney(input.amountCents) }) }}
    </p>
    <template v-if="input.count">
      <details v-if="input.items.length" class="preview" @toggle="previewOpen = ($event.currentTarget as HTMLDetailsElement).open">
        <summary>{{ t('stats.ai.preview', { count: input.items.length }) }}</summary>
        <ul v-if="previewOpen"><li v-for="item in input.items" :key="item.title">{{ item.title }}</li></ul>
      </details>
      <div class="actions">
        <button v-if="pending" type="button" class="action" @click="cancel">{{ t('forms.cancel') }}</button>
        <button v-else type="button" class="action primary" @click="analyze">{{ t(rows ? 'stats.ai.again' : 'stats.ai.analyze') }}</button>
        <span v-if="pending" class="muted" role="status">{{ t('stats.ai.wait') }}</span>
        <RouterLink :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <table v-if="rows" :aria-label="t('stats.ai.title')">
        <thead><tr>
          <th scope="col">{{ t('stats.ai.category') }}</th>
          <th scope="col">{{ t('stats.ai.count') }}</th>
          <th scope="col">{{ t('stats.ai.amount') }}</th>
          <th scope="col">{{ t('stats.ai.share') }}</th>
        </tr></thead>
        <tbody><tr v-for="row in rows" :key="row.category">
          <th scope="row">{{ t('stats.ai.category.' + row.category) }}</th>
          <td>{{ row.count }}</td>
          <td class="amount">{{ formatMoney(row.amountCents) }}</td>
          <td><div class="proportion">
            <span class="track" aria-hidden="true"><span :style="{ width: row.share * 100 + '%' }" /></span>
            {{ percent.format(row.share) }}
          </div></td>
        </tr></tbody>
      </table>
    </template>
    <p v-else class="muted">{{ t('stats.ai.empty') }}</p>
  </section>
</template>

<style scoped>
.analysis { display: grid; gap: 14px; }
header, h2, .actions, .scope, .proportion { display: flex; align-items: center; }
header { justify-content: space-between; flex-wrap: wrap; gap: 10px; }
h2 { gap: 8px; font-size: 1.1rem; letter-spacing: -.025em; }
h2 svg { color: var(--green); flex-shrink: 0; }
.scope { background: var(--soft); padding: 3px; border-radius: 9px; }
.scope button { min-height: 34px; padding: 5px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--sub); font-size: .83rem; }
.scope button[aria-pressed="true"] { background: var(--surface); color: var(--green); font-weight: 650; box-shadow: 0 1px 4px #1024191a; }
.coverage, .muted, .preview { font-size: .85rem; color: var(--sub); }
.coverage, table { font-variant-numeric: tabular-nums; }
.preview summary { cursor: pointer; color: var(--green); width: fit-content; }
.preview ul { max-height: 10rem; overflow-y: auto; padding-inline-start: 1.5rem; margin: 8px 0 0; overflow-wrap: anywhere; }
.actions { gap: 12px; flex-wrap: wrap; }
.actions a { color: var(--green); font-size: .85rem; }
.action { min-height: 42px; border: 1px solid var(--line); border-radius: 9px; padding: 6px 14px; background: var(--surface); color: var(--ink); font-weight: 600; }
.primary { background: var(--green); color: var(--surface); border-color: var(--green); }
.error { color: #a03123; font-size: .875rem; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: end; font-size: .9rem; overflow-wrap: anywhere; }
th, td { padding: 9px 4px; border-bottom: 1px solid var(--line); }
th:first-child { text-align: start; width: 29%; }
th:nth-child(2) { width: 13%; }
th:nth-child(3) { width: 25%; }
thead th { color: var(--sub); font-size: .8rem; font-weight: 550; }
tbody th { font-weight: 550; }
.amount { font-weight: 650; }
.proportion { gap: 8px; justify-content: flex-end; }
.track { height: 6px; flex: 1; margin-inline: 10%; background: var(--soft); }
.track, .track > span { border-radius: 4px; }
.track > span { display: block; height: 100%; background: #52816a; }
@media (max-width: 540px) {
  .track { display: none; }
  th:first-child { width: 33%; }
  th:nth-child(2) { width: 15%; }
  th:nth-child(3) { width: 30%; }
}
@media (pointer: coarse) {
  .scope button, .action { min-height: 44px; }
}
</style>
