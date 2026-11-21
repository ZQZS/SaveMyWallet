<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { formatMoney, formatMonth, t } from '../../i18n'
import { classifySpendingTitles } from '../../integrations/ai/deepseek'
import { useAssistantRequest } from '../ai/useAssistantRequest'
import type { StatisticsMonth } from './statistics'
import { analyzeCategorySpending, prepareCategorySpending, type CategorySpendingRow } from './spendingCategories'
import SpendingCategoryTable from './SpendingCategoryTable.vue'

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
      <details v-if="input.titles.length" class="preview" @toggle="previewOpen = ($event.currentTarget as HTMLDetailsElement).open">
        <summary>{{ t('stats.ai.preview', { count: input.titles.length }) }}</summary>
        <ul v-if="previewOpen"><li v-for="title in input.titles" :key="title">{{ title }}</li></ul>
      </details>
      <div class="actions">
        <button v-if="pending" type="button" class="action" @click="cancel">{{ t('forms.cancel') }}</button>
        <button v-else type="button" class="action primary" @click="analyze">{{ t(rows ? 'stats.ai.again' : 'stats.ai.analyze') }}</button>
        <span v-if="pending" class="muted" role="status">{{ t('stats.ai.wait') }}</span>
        <RouterLink :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <SpendingCategoryTable v-if="rows" :rows="rows" />
    </template>
    <p v-else class="muted">{{ t('stats.ai.empty') }}</p>
  </section>
</template>

<style scoped>
.analysis { display: grid; gap: 14px; }
header, h2, .actions, .scope { display: flex; align-items: center; }
header { justify-content: space-between; flex-wrap: wrap; gap: 10px; }
h2 { gap: 8px; font-size: 1.1rem; letter-spacing: -.025em; }
h2 svg { color: var(--green); flex-shrink: 0; }
.scope { background: var(--soft); padding: 3px; border-radius: 9px; }
.scope button { min-height: 34px; padding: 5px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--sub); font-size: .83rem; }
.scope button[aria-pressed="true"] { background: var(--surface); color: var(--green); font-weight: 650; box-shadow: 0 1px 4px #1024191a; }
.coverage, .muted, .preview { font-size: .85rem; color: var(--sub); }
.coverage { font-variant-numeric: tabular-nums; }
.preview summary { cursor: pointer; color: var(--green); width: fit-content; }
.preview ul { max-height: 10rem; overflow-y: auto; padding-inline-start: 1.5rem; margin: 8px 0 0; overflow-wrap: anywhere; }
.actions { gap: 12px; flex-wrap: wrap; }
.actions a { color: var(--green); font-size: .85rem; }
.action { min-height: 42px; border: 1px solid var(--line); border-radius: 9px; padding: 6px 14px; background: var(--surface); color: var(--ink); font-weight: 600; }
.primary { background: var(--accent-solid); color: var(--on-accent); border-color: var(--accent-solid); }
.error { color: var(--danger-ink); font-size: .875rem; }
@media (pointer: coarse) {
  .scope button, .action { min-height: 44px; }
}
</style>
