<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, ChevronRight } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { Entry } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import BillEntryDescription from '../../shared/components/BillEntryDescription.vue'
import { entryStatusLabel } from '../../shared/entryStatusLabel'
import '../../shared/styles/ledger-forms.css'

const props = defineProps<{ id: string }>()
const { data: ledger } = useLedgerSession()
const router = useRouter()
const platform = computed(() => ledger.value?.platforms.find(item => item.id === props.id))
const months = computed(() => {
  const groups = new Map<string, Entry[]>()
  for (const entry of ledger.value?.entries ?? []) {
    if (entry.platformId !== props.id) continue
    const group = groups.get(entry.month)
    if (group) group.push(entry)
    else groups.set(entry.month, [entry])
  }
  return [...groups].sort(([left], [right]) => right.localeCompare(left))
})

function backToPlatforms() {
  const list = { name: 'platforms' }
  if (router.options.history.state.back === router.resolve(list).fullPath) router.back()
  else router.replace(list)
}
</script>

<template>
  <section v-if="ledger" class="ledger-editor" aria-labelledby="platform-detail-heading">
    <header class="ledger-form-head">
      <button type="button" class="ledger-back" :aria-label="t('forms.backToPlatforms')" :title="t('forms.backToPlatforms')" @click="backToPlatforms">
        <ArrowLeft :size="20" aria-hidden="true" />
      </button>
      <h1 id="platform-detail-heading">{{ platform ? t('ledger.detailsFor', { name: platform.name }) : t('forms.platformNotFound') }}</h1>
    </header>
    <template v-if="platform">
      <p v-if="!months.length" class="ledger-sheet ledger-hint">{{ t('forms.platformBillsEmpty') }}</p>
      <section v-for="[month, entries] in months" :key="month" class="ledger-sheet month-group" :aria-labelledby="'platform-month-' + month">
        <header class="ledger-list-title">
          <h2 :id="'platform-month-' + month"><time :datetime="month">{{ formatMonth(month) }}</time></h2>
          <span>{{ t('forms.entryCount', { count: entries.length }) }}</span>
        </header>
        <ul>
          <li v-for="entry in entries" :key="entry.id">
            <RouterLink class="bill-link" :to="{ name: 'ledger', query: { entry: entry.id } }">
              <BillEntryDescription :entry="entry" />
              <span class="bill-figures">
                <small v-if="entry.kind === 'estimate'">{{ t('ledger.balancePayment') }}</small>
                <strong :class="{ voided: entry.voided }">{{ formatMoney(entry.amountCents) }}</strong>
                <small>{{ entryStatusLabel(entry) }}</small>
              </span>
              <ChevronRight :size="16" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
h1 { overflow-wrap: anywhere; }
.month-group { gap: 12px; }
.month-group ul { padding: 0; list-style: none; }
.month-group li { border-top: 1px solid var(--line); }
.bill-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, max-content) auto;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 10px 0;
  color: var(--ink);
  text-decoration: none;
}
.bill-link:is(:hover, :focus-visible), .bill-link > svg { color: var(--green); }
.bill-figures { display: grid; gap: 2px; max-width: 12em; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.bill-figures small { color: var(--sub); font-size: .78rem; }
.bill-figures .voided { color: var(--sub); text-decoration: line-through; }
@media (max-width: 480px) {
  .bill-link { gap: 6px; }
  .bill-figures { max-width: 8em; }
}
</style>
