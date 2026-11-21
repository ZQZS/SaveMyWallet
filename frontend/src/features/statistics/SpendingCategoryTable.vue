<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import BillEntryDescription from '../../shared/components/BillEntryDescription.vue'
import { entryStatusLabel } from '../../shared/entryStatusLabel'
import type { CategorySpendingRow, SpendingCategory } from './spendingCategories'

defineProps<{ rows: CategorySpendingRow[] }>()
const expanded = ref(new Set<SpendingCategory>())
const percent = computed(() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 1 }))

function toggle(category: SpendingCategory) {
  if (expanded.value.has(category)) expanded.value.delete(category)
  else expanded.value.add(category)
}
</script>

<template>
  <table :aria-label="t('stats.ai.title')">
    <thead><tr>
      <th scope="col">{{ t('stats.ai.category') }}</th>
      <th scope="col">{{ t('stats.ai.count') }}</th>
      <th scope="col">{{ t('stats.ai.amount') }}</th>
      <th scope="col">{{ t('stats.ai.share') }}</th>
    </tr></thead>
    <tbody v-for="row in rows" :key="row.category">
      <tr class="category-row" @click="toggle(row.category)">
        <th scope="row">
          <button type="button" class="category-toggle" :aria-expanded="expanded.has(row.category)"
            :aria-controls="expanded.has(row.category) ? 'bills-' + row.category : undefined"
            :aria-label="t('stats.ai.categoryBills', { category: t('stats.ai.category.' + row.category) })">
            <ChevronRight :size="16" aria-hidden="true" />{{ t('stats.ai.category.' + row.category) }}
          </button>
        </th>
        <td>{{ row.count }}</td>
        <td class="amount">{{ formatMoney(row.amountCents) }}</td>
        <td><div class="proportion">
          <span class="track" aria-hidden="true"><span :style="{ width: row.share * 100 + '%' }" /></span>
          {{ percent.format(row.share) }}
        </div></td>
      </tr>
      <tr v-if="expanded.has(row.category)" :id="'bills-' + row.category">
        <td colspan="4" class="details-cell">
          <ul :aria-label="t('stats.ai.categoryBills', { category: t('stats.ai.category.' + row.category) })">
            <li v-for="{ entry, platform } in row.details" :key="entry.id">
              <div>
                <BillEntryDescription :entry="entry" />
                <small><time :datetime="entry.month">{{ formatMonth(entry.month) }}</time> · {{ platform.name }}</small>
              </div>
              <div class="figures">
                <small v-if="entry.kind === 'estimate'">{{ t('ledger.balancePayment') }}</small>
                <strong>{{ formatMoney(entry.amountCents) }}</strong>
                <small>{{ entryStatusLabel(entry) }}</small>
              </div>
            </li>
          </ul>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table { width: 100%; border-collapse: collapse; table-layout: fixed; text-align: end; font-size: .9rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
th, td { padding: 9px 4px; border-bottom: 1px solid var(--line); }
th:first-child { text-align: start; width: 29%; }
th:nth-child(2) { width: 13%; }
th:nth-child(3) { width: 25%; }
thead th { color: var(--sub); font-size: .8rem; font-weight: 550; }
.category-row { cursor: pointer; }
.category-row:hover { background: var(--soft); }
.category-row th { padding-block: 0; }
.category-toggle { display: flex; align-items: center; gap: 5px; width: 100%; min-height: 44px; padding: 4px 0; border: 0; background: transparent; color: var(--green); text-align: start; overflow-wrap: anywhere; font-weight: 600; }
.category-toggle svg { flex-shrink: 0; }
.category-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
.amount { font-weight: 650; }
.proportion { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.track { height: 6px; flex: 1; margin-inline: 10%; background: var(--soft); }
.track, .track > span { border-radius: 4px; }
.track > span { display: block; height: 100%; background: #52816a; }
.details-cell { padding: 0 12px; background: var(--paper); text-align: start; }
.details-cell ul { margin: 0; padding: 0; list-style: none; }
.details-cell li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content); align-items: center; gap: 12px; padding: 10px 0; }
.details-cell li + li { border-top: 1px solid var(--line); }
.details-cell small { color: var(--sub); font-size: .78rem; }
.figures { display: grid; gap: 2px; max-width: 12em; text-align: end; }
@media (max-width: 540px) {
  .track { display: none; }
  th:first-child { width: 33%; }
  th:nth-child(2) { width: 15%; }
  th:nth-child(3) { width: 30%; }
  .figures { max-width: 8em; }
}
</style>
