<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import type { Platform } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import { searchStatusKeys } from '../../i18n/messages/ledgerSearch'
import type { LedgerSearchFilters, LedgerSearchResult } from './ledgerSearch'

const props = defineProps<{ result: LedgerSearchResult; filters: LedgerSearchFilters; platforms: Platform[]; shown: number }>()
const emit = defineEmits<{ more: [] }>()
const platformNames = computed(() => new Map(props.platforms.map(p => [p.id, p.name])))
const heading = ref<HTMLElement | null>(null)
defineExpose({ focus: () => heading.value?.focus() })

function monthRange({ fromMonth, toMonth }: LedgerSearchFilters) {
  if (fromMonth && toMonth) return fromMonth === toMonth ? formatMonth(fromMonth) :
    t('ai.search.range', { start: formatMonth(fromMonth), end: formatMonth(toMonth) })
  if (fromMonth) return t('ai.search.from', { month: formatMonth(fromMonth) })
  if (toMonth) return t('ai.search.through', { month: formatMonth(toMonth) })
  return t('ai.search.anyMonth')
}

const scope = computed(() => {
  const filters = props.filters
  const terms = [monthRange(filters), t(filters.voided === 'voided' ? 'ledger.voided' : 'ai.search.' + filters.voided)]
  if (filters.platform) terms.push(t('ai.search.platformMatch', { platform: filters.platform }))
  if (filters.title) terms.push(t('ai.search.titleMatch', { title: filters.title }))
  if (filters.kind) terms.push(t('forms.' + filters.kind))
  for (const status of filters.statuses) terms.push(t(searchStatusKeys[status]))
  if (filters.hasDeposit !== null) terms.push(t(filters.hasDeposit ? 'ai.search.withDeposit' : 'ai.search.withoutDeposit'))
  if (filters.outstandingOnly) terms.push(t('ai.search.outstanding'))
  return terms.join(' · ')
})
</script>

<template>
  <section class="ledger-sheet results" aria-labelledby="search-results-heading">
    <header>
      <h2 id="search-results-heading" ref="heading" tabindex="-1">{{ t('ai.search.results', { count: result.entries.length }) }}</h2>
      <p class="ledger-hint scope">{{ scope }}</p>
    </header>
    <section aria-labelledby="search-totals-heading">
      <h3 id="search-totals-heading">{{ t('ai.search.activeTotals') }} <strong>{{ formatMoney(result.total) }}</strong></h3>
      <dl class="totals">
        <div v-for="(label, status) in searchStatusKeys" :key="status">
          <dt>{{ t(label) }}</dt>
          <dd>{{ formatMoney(result[status]) }}</dd>
        </div>
      </dl>
    </section>
    <p v-if="!result.entries.length" class="ledger-hint">{{ t('ai.search.empty') }}</p>
    <ul v-else>
      <li v-for="entry in result.entries.slice(0, shown)" :key="entry.id">
        <RouterLink class="entry" :to="{ name: 'ledger', query: { entry: entry.id } }">
          <span class="description">
            <strong>{{ entry.title }}</strong>
            <small>{{ formatMonth(entry.month) }} · {{ platformNames.get(entry.platformId) }} ·
              {{ entry.kind === 'installment' && entry.installmentIndex && entry.installmentCount
                ? t('ledger.installment', { index: entry.installmentIndex, count: entry.installmentCount }) : t('forms.' + entry.kind) }}</small>
            <small v-if="entry.kind === 'estimate' && entry.depositCents">{{ t('ledger.paidDeposit') }} {{ formatMoney(entry.depositCents) }}</small>
          </span>
          <span class="amount">
            <strong>{{ formatMoney(entry.amountCents) }}</strong>
            <small>{{ entry.voided ? t('ledger.voided') : t(searchStatusKeys[entry.status]) }}</small>
          </span>
          <ChevronRight :size="16" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>
    <button v-if="result.entries.length > shown" type="button" class="ledger-secondary" @click="emit('more')">
      {{ t('ai.search.showMore', { count: result.entries.length - shown }) }}
    </button>
  </section>
</template>

<style scoped>
.results { gap: 14px; }
.scope { margin-top: 4px; overflow-wrap: anywhere; }
h3, dt, small { font-size: .82rem; }
h3 { margin: 0 0 6px; }
h3 strong { margin-inline-start: 4px; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.totals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 12px; background: var(--soft); border-radius: 8px; }
dt, small { color: var(--sub); }
dd { margin: 2px 0 0; font-weight: 650; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
ul { list-style: none; padding: 0; }
li + li { border-top: 1px solid var(--line); }
.entry { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 12px 2px; text-decoration: none; color: var(--ink); }
.entry:is(:hover, :focus-visible) strong, .entry svg { color: var(--green); }
.entry:focus-visible { outline: 2px solid var(--green); }
.description, .amount { display: grid; gap: 4px; overflow-wrap: anywhere; }
.amount { max-width: 12em; text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) {
  .entry, .totals { gap: 6px; }
  .amount { max-width: 8em; }
}
</style>
