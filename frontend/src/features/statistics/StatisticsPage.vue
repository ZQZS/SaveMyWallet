<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowRight } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { isMonth, MAX_MONTH, MIN_MONTH, shiftMonth } from '../../domain/ledger'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import { buildStatistics, type StatisticsRange } from './statistics'
import MonthlyTrendChart from './MonthlyTrendChart.vue'

const { data, month: ledgerMonth, busy, selectMonth, calculateMonth } = useLedgerSession()
const route = useRoute()
const router = useRouter()
const ranges = [6, 12] as const
const range = computed<StatisticsRange>(() => route.query.range === '12' ? 12 : 6)
const endMonth = computed(() => {
  const end = route.query.end
  return typeof end === 'string' && isMonth(end) ? end : ledgerMonth.value
})
const points = computed(() => data.value ? buildStatistics(data.value, endMonth.value, range.value, calculateMonth) : [])
const selected = computed(() => points.value.find(point => point.month === route.query.month) ?? points.value.at(-1))
const totals = computed(() => {
  let salary = 0
  let spending = 0
  for (const point of points.value) {
    salary += point.salary
    spending += point.total
  }
  return { salary, spending, balance: salary - spending }
})
const platforms = computed(() => selected.value?.groups.filter(group => group.total > 0).sort((a, b) => b.total - a.total) ?? [])
const percent = computed(() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 1 }))

function setView(end: string, length: StatisticsRange, month = end) {
  const inRange = month >= shiftMonth(end, 1 - length) && month <= end
  void router.replace({ name: 'statistics', query: {
    end, range: length === 12 ? '12' : undefined, month: inRange && month !== end ? month : undefined,
  } })
}

function changeEndMonth(event: Event) {
  const input = event.target as HTMLInputElement
  if (isMonth(input.value)) setView(input.value, range.value)
  else input.value = endMonth.value
}

async function openLedger() {
  const month = selected.value?.month
  if (!month) return
  const failure = await router.push({ name: 'ledger' })
  if (!failure && month !== ledgerMonth.value) selectMonth(month)
}
</script>

<template>
  <div v-if="selected" class="statistics">
    <header class="page-heading">
      <div>
        <h1>{{ t('stats.title') }}</h1>
        <p class="date-range"><time :datetime="points[0].month">{{ formatMonth(points[0].month) }}</time>
          – <time :datetime="endMonth">{{ formatMonth(endMonth) }}</time></p>
      </div>
      <div class="filters">
        <div class="range-switch" role="group" :aria-label="t('stats.range')">
          <button v-for="length in ranges" :key="length" type="button" :aria-pressed="range === length"
            :disabled="busy" @click="setView(endMonth, length, selected.month)">{{ t('stats.months', { count: length }) }}</button>
        </div>
        <label class="month-filter">{{ t('stats.endMonth') }}
          <input type="month" :value="endMonth" :min="MIN_MONTH" :max="MAX_MONTH" :disabled="busy" @change="changeEndMonth">
        </label>
      </div>
    </header>

    <dl class="period-summary">
      <div class="period-balance"><dt>{{ t('stats.periodBalance') }}</dt><dd>{{ formatMoney(totals.balance) }}</dd></div>
      <div><dt>{{ t('stats.periodSalary') }}</dt><dd>{{ formatMoney(totals.salary) }}</dd></div>
      <div><dt>{{ t('stats.periodSpending') }}</dt><dd>{{ formatMoney(totals.spending) }}</dd></div>
    </dl>

    <div class="trends">
      <section class="panel trend" aria-labelledby="spending-heading">
        <h2 id="spending-heading">{{ t('stats.spendingTrend') }}</h2>
        <MonthlyTrendChart :points="points" kind="spending" :selected-month="selected.month" @select="setView(endMonth, range, $event)" />
      </section>
      <section class="panel trend" aria-labelledby="balance-heading">
        <h2 id="balance-heading">{{ t('stats.balanceTrend') }}</h2>
        <MonthlyTrendChart :points="points" kind="balance" :selected-month="selected.month" @select="setView(endMonth, range, $event)" />
        <p class="formula">{{ t('stats.balanceFormula') }}</p>
      </section>
    </div>

    <section class="panel breakdown" aria-labelledby="share-heading">
      <header class="breakdown-heading">
        <div>
          <h2 id="share-heading">{{ t('stats.platformShare') }}</h2>
          <p class="selected-period"><time :datetime="selected.month">{{ formatMonth(selected.month) }}</time>
            · {{ t('stats.selectedSpending', { amount: formatMoney(selected.total) }) }}</p>
        </div>
        <button type="button" class="ledger-link" :disabled="busy" @click="openLedger">
          {{ t('stats.openLedger') }} <ArrowRight :size="15" aria-hidden="true" />
        </button>
      </header>
      <ul v-if="platforms.length" class="platform-bars">
        <li v-for="group in platforms" :key="group.platform.id">
          <span class="platform-name">{{ group.platform.name }}</span>
          <span class="bar-track" aria-hidden="true"><span :style="{ width: group.total / selected.total * 100 + '%' }" /></span>
          <span class="share">{{ percent.format(group.total / selected.total) }}</span>
          <strong>{{ formatMoney(group.total) }}</strong>
        </li>
      </ul>
      <p v-else class="empty">{{ t('stats.noSpending') }}</p>
    </section>
  </div>
</template>

<style scoped>
.statistics { display: grid; gap: 20px; min-width: 0; }
.page-heading, .filters, .breakdown-heading, .ledger-link { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.page-heading, .breakdown-heading { justify-content: space-between; }
h1 { font-size: clamp(1.55rem, 3vw, 2rem); line-height: 1.2; letter-spacing: -.04em; }
h2 { font-size: 1.1rem; letter-spacing: -.025em; }
.date-range, .selected-period, .formula, .empty { color: var(--sub); font-size: .85rem; }
.date-range, .selected-period { margin-top: 5px; }
.range-switch { display: flex; gap: 2px; padding: 3px; background: var(--soft); border-radius: 10px; }
.range-switch button { min-height: 36px; padding: 5px 12px; border: 0; background: transparent; color: var(--sub); border-radius: 7px; font-size: .83rem; }
.range-switch button[aria-pressed="true"] { background: var(--surface); color: var(--green); font-weight: 650; box-shadow: 0 1px 4px #1024191a; }
.month-filter { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; font-size: .8rem; color: var(--sub); }
.month-filter input { min-width: 0; max-width: 100%; min-height: 42px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--ink); padding: 4px 8px; }
.period-summary { display: grid; grid-template-columns: 1.25fr 1fr 1fr; margin: 0; border-radius: 16px; background: var(--soft); overflow: hidden; }
.period-summary > div { min-width: 0; padding: clamp(16px, 2.5vw, 28px); align-content: center; }
.period-summary dt { font-size: .88rem; color: var(--sub); }
.period-summary dd { margin: 5px 0 0; font-weight: 650; font-size: clamp(1.25rem, 2.9vw, 2rem); letter-spacing: -.04em; }
.period-summary .period-balance { background: var(--green); color: #fffef9; }
.period-balance dt { color: #e0ecde; }
.period-balance dd { font-size: clamp(1.65rem, 3.5vw, 2.5rem); }
.statistics dd, .platform-bars { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.trends { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.panel { min-width: 0; padding: clamp(16px, 2.3vw, 26px); background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }
.trend { display: grid; align-content: start; gap: 16px; }
.formula { font-size: .78rem; }
.ledger-link { gap: 5px; min-height: 42px; padding: 5px 0; color: var(--green); border: 0; background: transparent; font-size: .85rem; font-weight: 650; }
.ledger-link:hover { text-decoration: underline; }
.platform-bars { list-style: none; display: grid; gap: 14px; padding: 0; margin: 20px 0 0; }
.platform-bars li { display: grid; grid-template-columns: minmax(5.5em, 1fr) minmax(3em, 2fr) 4em minmax(5em, .7fr); align-items: center; gap: 14px; font-size: .9rem; }
.platform-bars strong, .share { text-align: right; }
.share { font-size: .8rem; color: var(--sub); }
.bar-track, .bar-track > span { display: block; height: 8px; border-radius: 4px; }
.bar-track { background: var(--soft); }
.bar-track > span { background: #52816a; }
.empty { margin-top: 18px; }
@media (max-width: 800px) { .trends { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 580px) {
  .statistics, .trends { gap: 14px; }
  .filters { gap: 8px; }
  .period-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .period-balance { grid-column: 1 / -1; }
  .platform-bars li { grid-template-columns: 1fr auto auto; gap: 4px 10px; }
  .bar-track { grid-row: 2; grid-column: 1 / -1; }
}
@media (pointer: coarse) {
  .range-switch button, .month-filter input, .ledger-link { min-height: 44px; }
}
</style>
