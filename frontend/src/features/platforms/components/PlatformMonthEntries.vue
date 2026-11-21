<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import type { Entry } from '../../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../../i18n'
import BillEntryDescription from '../../../shared/components/BillEntryDescription.vue'
import { entryStatusLabel } from '../../../shared/entryStatusLabel'

const props = defineProps<{ month: string; entries: Entry[]; disabled: boolean }>()
const selected = defineModel<Set<string>>({ required: true })
const available = computed(() => props.entries.filter(entry => !entry.voided))
const checkedCount = computed(() => available.value.filter(entry => selected.value.has(entry.id)).length)

function setChecked(entries: Entry[], event: Event) {
  if (props.disabled) return
  const checked = (event.currentTarget as HTMLInputElement).checked
  const next = new Set(selected.value)
  for (const entry of entries) {
    if (entry.voided) continue
    if (checked) next.add(entry.id)
    else next.delete(entry.id)
  }
  selected.value = next
}
</script>

<template>
  <section class="ledger-sheet month-group" :aria-labelledby="'platform-month-' + month">
    <header class="ledger-list-title">
      <h2 :id="'platform-month-' + month"><time :datetime="month">{{ formatMonth(month) }}</time></h2>
      <span class="entry-count">{{ t('forms.entryCount', { count: entries.length }) }}</span>
      <label class="choose-month">
        <input type="checkbox" :disabled="disabled || !available.length"
          :aria-labelledby="'select-month-' + month + ' platform-month-' + month"
          :checked="checkedCount > 0 && checkedCount === available.length"
          :indeterminate="checkedCount > 0 && checkedCount < available.length" @change="setChecked(available, $event)" />
        <span :id="'select-month-' + month">{{ t('forms.selectMonthEntries') }}</span>
      </label>
    </header>
    <ul>
      <li v-for="entry in entries" :key="entry.id">
        <label class="choose-entry">
          <input type="checkbox" :value="entry.id" :checked="!entry.voided && selected.has(entry.id)"
            :disabled="disabled || entry.voided" :aria-label="t('forms.selectEntryForAction', {
              title: entry.title, month: formatMonth(month), amount: formatMoney(entry.amountCents),
            })" @change="setChecked([entry], $event)" />
        </label>
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

<style scoped>
.month-group { gap: 12px; }
.entry-count { margin-inline-end: auto; }
.month-group ul { margin: 0; padding: 0; list-style: none; }
.month-group li { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: stretch; border-top: 1px solid var(--line); }
.choose-month, .choose-entry { display: inline-flex; align-items: center; min-height: 44px; cursor: pointer; }
.choose-month { gap: 8px; font-size: .85rem; }
.choose-entry { width: 44px; }
.choose-month:has(:disabled), .choose-entry:has(:disabled) { cursor: default; }
.month-group input[type="checkbox"] { flex: none; width: 18px; height: 18px; min-height: 0; padding: 0; margin: 0; accent-color: var(--accent-solid); }
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
