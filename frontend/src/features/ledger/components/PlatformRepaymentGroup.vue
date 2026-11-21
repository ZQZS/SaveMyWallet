<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import type { Entry, PlatformGroup } from '../../../domain/ledger'
import { formatMoney, t } from '../../../i18n'
import BillEntryDescription from '../../../shared/components/BillEntryDescription.vue'
import { entryStatusLabel } from '../../../shared/entryStatusLabel'

const props = defineProps<{ group: PlatformGroup; expanded: boolean; busy: boolean; linkedId?: string }>()
const emit = defineEmits<{
  toggle: []
  pay: [ids: string[], paid: boolean]
  confirm: [entry: Entry]
  setVoided: [entry: Entry, voided: boolean]
}>()

const activeEntries = computed(() => props.group.entries.filter(entry => !entry.voided))
const voidedCount = computed(() => props.group.entries.length - activeEntries.value.length)
const paidInFull = computed(() => props.group.paid > 0 && props.group.due === 0)
const partiallyPaid = computed(() => props.group.paid > 0 && props.group.due > 0)
const hasConfirmedBills = computed(() => props.group.due > 0 || props.group.paid > 0)
const hasEstimates = computed(() => activeEntries.value.some(entry => entry.status === 'estimated'))
const status = computed(() => {
  if (!activeEntries.value.length) return { label: t('ledger.allVoided'), tone: 'voided' }
  if (!hasConfirmedBills.value) return hasEstimates.value
    ? { label: t('ledger.needsConfirmation'), tone: 'estimated' }
    : { label: t('ledger.noBalancePayment'), tone: 'paid' }
  if (partiallyPaid.value) return { label: t('ledger.partiallyPaid'), tone: 'partial' }
  if (paidInFull.value) return { label: t(hasEstimates.value ? 'ledger.confirmedPaid' : 'ledger.paid'), tone: 'paid' }
  return { label: t('ledger.unpaid'), tone: 'due' }
})

const platformMark = computed(() => Array.from(props.group.platform.name)[0])
const markTone = computed(() => {
  let hash = 0
  for (const char of props.group.platform.id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return Math.abs(hash) % 5
})

function changePayment() {
  if (props.busy || !hasConfirmedBills.value) return
  const paid = !paidInFull.value
  const selected = activeEntries.value.filter(entry => entry.amountCents > 0 && entry.status === (paid ? 'due' : 'paid'))
  emit('pay', selected.map(entry => entry.id), paid)
}

</script>

<template>
  <li class="platform">
    <div class="platform-row">
      <span v-if="!hasConfirmedBills" class="ineligible" :title="hasEstimates ? t('ledger.confirmFirst') : undefined">—</span>
      <label v-else class="check-target">
        <input type="checkbox" :checked="paidInFull" :indeterminate="partiallyPaid"
          :disabled="busy" :aria-label="t(paidInFull ? 'ledger.undoPaymentFor' : 'ledger.payFor', { name: group.platform.name })"
          @click.prevent="changePayment">
      </label>
      <button type="button" class="platform-toggle" :aria-expanded="expanded"
        :aria-controls="'details-' + group.platform.id" @click="emit('toggle')">
        <span class="platform-title">
          <span class="platform-mark" :data-tone="markTone" aria-hidden="true">{{ platformMark }}</span>
          <span class="platform-label">
            <strong>{{ group.platform.name }}</strong>
            <small>{{ t('ledger.billCount', { count: group.entries.length }) }}<span v-if="voidedCount && activeEntries.length">{{ t('ledger.voidedForGroup', { count: voidedCount }) }}</span><span
              v-if="partiallyPaid">{{ t('ledger.remainingForGroup', { amount: formatMoney(group.due) }) }}</span><span
              v-if="group.estimated && hasConfirmedBills">{{ t('ledger.estimatesForGroup', { amount: formatMoney(group.estimated) }) }}</span></small>
          </span>
        </span>
        <strong class="group-total">{{ formatMoney(group.total) }}</strong>
        <span class="status-cell"><span class="state" :class="status.tone">{{ status.label }}</span>
          <ChevronDown class="disclosure" :class="{ expanded }" :size="16" aria-hidden="true" />
        </span>
      </button>
    </div>
    <ul v-if="expanded" class="details" :id="'details-' + group.platform.id" :aria-label="t('ledger.detailsFor', { name: group.platform.name })">
      <li v-for="entry in group.entries" :key="entry.id" class="entry"
        :class="{ 'is-voided': entry.voided, 'linked-entry': linkedId === entry.id }"
        :aria-current="linkedId === entry.id ? 'true' : undefined" :tabindex="linkedId === entry.id ? -1 : undefined">
        <BillEntryDescription :entry="entry" />
        <strong class="entry-amount"><small v-if="entry.kind === 'estimate'">{{ t('ledger.balancePayment') }} </small>{{ formatMoney(entry.amountCents) }}</strong>
        <button v-if="!entry.voided && entry.status === 'estimated'" class="entry-action confirm-action" type="button" :disabled="busy"
          :aria-label="t('ledger.confirmBill', { title: entry.title })" @click="emit('confirm', entry)">{{ t('ledger.confirmEstimate') }}</button>
        <span v-else class="entry-state" :class="{ 'is-paid': !entry.voided && (entry.status === 'paid' || (entry.kind === 'estimate' && entry.amountCents === 0)) }">
          {{ entryStatusLabel(entry) }}
        </span>
        <button class="entry-action void-action" type="button" :disabled="busy"
          :aria-haspopup="entry.kind === 'installment' ? 'dialog' : undefined"
          :aria-label="t(entry.voided ? 'ledger.restoreBill' : 'ledger.voidBill', { title: entry.title })"
          @click="emit('setVoided', entry, !entry.voided)">{{ t(entry.voided ? 'ledger.restore' : 'ledger.void') }}</button>
      </li>
    </ul>
  </li>
</template>

<style scoped>
.platform + .platform { border-top: 1px solid var(--line); }
.platform-row {
  display: grid;
  grid-template-columns: var(--check-width) minmax(0, 1fr);
  align-items: center;
  column-gap: var(--column-gap);
  padding-inline: var(--row-padding);
}
.check-target, .ineligible { display: grid; place-items: center; min-height: 44px; }
.check-target, .check-target input { cursor: pointer; }
.check-target:has(input:disabled), .check-target input:disabled { cursor: wait; }
.check-target input { width: 19px; height: 19px; margin: 0; accent-color: var(--accent-solid); }
.ineligible { color: var(--sub); }
.platform-toggle {
  display: grid;
  grid-template-columns: var(--content-columns);
  align-items: center;
  gap: var(--column-gap);
  width: 100%;
  min-width: 0;
  padding: 14px 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}
.platform-toggle:hover .platform-label strong { color: var(--green); }
.platform-title { display: flex; align-items: center; min-width: 0; gap: 12px; }
.platform-mark {
  --platform-tone: #37875d;
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--platform-tone) 15%, var(--surface));
  color: color-mix(in srgb, var(--platform-tone) 42%, var(--ink));
  font-weight: 700;
}
.platform-mark[data-tone="1"] { --platform-tone: #ba632f; }
.platform-mark[data-tone="2"] { --platform-tone: #437bad; }
.platform-mark[data-tone="3"] { --platform-tone: #b5527e; }
.platform-mark[data-tone="4"] { --platform-tone: #8062a3; }
.platform-label { display: grid; min-width: 0; gap: 3px; overflow-wrap: anywhere; }
.platform-label strong { font-weight: 650; }
.platform-label small { color: var(--sub); font-size: 0.78rem; }
.group-total, .entry-amount {
  text-align: right;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.entry-amount small { display: block; color: var(--sub); font-size: .75rem; font-weight: 400; }
.status-cell { display: flex; align-items: center; justify-content: end; gap: 8px; }
.state { padding: 3px 8px; border-radius: 6px; white-space: nowrap; font-size: 0.78rem; font-weight: 600; }
.state.due, .state.voided { color: var(--sub); background: var(--soft); }
.state.partial { color: var(--partial-ink); background: var(--partial-bg); }
.state.estimated { color: var(--warning-ink); background: var(--warning-bg); }
.state.paid { color: var(--positive-ink); background: var(--positive-bg); }
.disclosure { flex: none; color: var(--sub); }
.disclosure.expanded { transform: rotate(180deg); }
.details { list-style: none; margin: 0; padding: 3px var(--row-padding) 3px calc(var(--check-width) + var(--column-gap) + var(--row-padding)); background: var(--paper); border-top: 1px dashed var(--line); }
.entry { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto auto; align-items: center; gap: 12px; padding: 8px 0; font-size: 0.88rem; }
.entry + .entry { border-top: 1px solid var(--line); }
.entry.linked-entry { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: 6px;
  background: var(--soft); padding-inline: 6px; scroll-margin-block: 20px; }
.entry-state, .entry-action { text-align: right; font-size: 0.8rem; }
.entry-state { min-width: 48px; color: var(--sub); }
.entry-state.is-paid { color: var(--positive-ink); }
.is-voided .entry-amount { color: var(--sub); text-decoration: line-through; }
.entry-action { justify-self: end; min-height: 44px; min-width: 44px; padding: 0 4px; font-weight: 650; background: transparent; border: 0; cursor: pointer; }
.confirm-action, .is-voided .void-action { color: var(--green); }
.void-action { color: var(--sub); }
@media (max-width: 650px) {
  .platform-toggle { grid-template-columns: minmax(0, 1fr) minmax(0, max-content); gap: 3px 8px; min-height: 76px; padding-block: 10px; }
  .platform-title { grid-area: 1 / 1 / 3; gap: 8px; }
  .platform-mark { width: 30px; height: 30px; border-radius: 8px; }
  .group-total { grid-area: 1 / 2; align-self: end; }
  .status-cell { grid-area: 2 / 2; align-self: start; gap: 4px; }
  .state { font-size: 0.7rem; padding: 2px 6px; max-width: 10em; white-space: normal; text-align: right; }
  .disclosure { width: 12px; }
  .details { padding-inline: 12px; }
  .entry { grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; }
  .entry-state, .confirm-action { justify-self: start; text-align: left; }
  .entry-action { padding: 0; }
}
@media (max-width: 370px) {
  .platform-mark { display: none; }
}
</style>
