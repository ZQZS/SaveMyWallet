<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Undo2 } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { Entry } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import { entryStatusLabel } from '../../shared/entryStatusLabel'
import PlatformMonthEntries from './components/PlatformMonthEntries.vue'
import PlatformSummary from './components/PlatformSummary.vue'
import '../../shared/styles/ledger-forms.css'

const props = defineProps<{ id: string }>()
const { data: ledger, platformSummaries, busy, needsReload, repository, commit, notice, lastPayment,
  markPayments, undoPayment, invalidatePaymentUndo } = useLedgerSession()
const router = useRouter()
const locked = computed(() => busy.value || needsReload.value)
const summary = computed(() => platformSummaries.value?.get(props.id))
const platformEntries = computed(() => ledger.value?.entries.filter(entry => entry.platformId === props.id) ?? [])
const selectedIds = ref(new Set<string>())
const selected = computed(() => platformEntries.value.filter(entry => !entry.voided && selectedIds.value.has(entry.id)))
const payable = computed(() => selected.value.filter(entry => entry.status === 'due' && entry.amountCents > 0))
const voidDialog = ref<HTMLDialogElement | null>(null)
let pendingVoid: { signature: string; operationId: string } | undefined
const months = computed(() => {
  const groups = new Map<string, Entry[]>()
  for (const entry of platformEntries.value) {
    const group = groups.get(entry.month)
    if (group) group.push(entry)
    else groups.set(entry.month, [entry])
  }
  return [...groups].sort(([left], [right]) => right.localeCompare(left))
})

watch(() => props.id, () => {
  selectedIds.value.clear()
  pendingVoid = undefined
  voidDialog.value?.close()
})

watch(platformEntries, entries => {
  if (!selectedIds.value.size) return
  const activeIds = new Set(entries.filter(entry => !entry.voided).map(entry => entry.id))
  for (const id of selectedIds.value) {
    if (!activeIds.has(id)) selectedIds.value.delete(id)
  }
  if (!selectedIds.value.size) voidDialog.value?.close()
})

function totalAmount(entries: Entry[]) {
  return formatMoney(entries.reduce((total, entry) => total + entry.amountCents, 0))
}

function clearChanged(ids: string[]) {
  for (const id of ids) selectedIds.value.delete(id)
}

function repaySelected() {
  const ids = payable.value.map(entry => entry.id)
  if (ids.length && !locked.value) return markPayments(ids, true, { platformId: props.id }, clearChanged)
}

function voidSelected() {
  const entries = selected.value
  if (!entries.length || locked.value) return
  const ids = entries.map(entry => entry.id).sort()
  const signature = JSON.stringify(ids)
  if (pendingVoid?.signature !== signature) pendingVoid = { signature, operationId: crypto.randomUUID() }
  const { operationId } = pendingVoid
  voidDialog.value?.close()
  return commit(() => repository.voidEntries(ids, operationId), changed => {
    pendingVoid = undefined
    clearChanged(ids)
    invalidatePaymentUndo(changed)
    notice.value = changed.length ? t('forms.voidedSelection', { count: changed.length }) : t('ledger.updated')
  })
}

function backToPlatforms() {
  const list = { name: 'platforms' }
  if (router.options.history.state.back === router.resolve(list).fullPath) router.back()
  else router.replace(list)
}
</script>

<template>
  <section v-if="ledger" class="ledger-editor" aria-labelledby="platform-detail-heading">
    <header class="ledger-form-head">
      <button type="button" class="ledger-back" :disabled="locked" :aria-label="t('forms.backToPlatforms')" :title="t('forms.backToPlatforms')" @click="backToPlatforms">
        <ArrowLeft :size="20" aria-hidden="true" />
      </button>
      <h1 id="platform-detail-heading">{{ summary ? t('ledger.detailsFor', { name: summary.platform.name }) : t('forms.platformNotFound') }}</h1>
    </header>
    <template v-if="summary">
      <section class="ledger-sheet" aria-labelledby="platform-summary-heading">
        <h2 id="platform-summary-heading">{{ t('forms.allMonthsSummary') }}</h2>
        <PlatformSummary :summary="summary" />
        <button v-if="lastPayment?.platformId === id" type="button" class="ledger-text-btn undo" :disabled="locked" @click="undoPayment()">
          <Undo2 :size="16" aria-hidden="true" />{{ t('ledger.undo') }}
        </button>
      </section>
      <p v-if="!months.length" class="ledger-sheet ledger-hint">{{ t('forms.platformBillsEmpty') }}</p>
      <PlatformMonthEntries v-for="[month, entries] in months" :key="month" v-model="selectedIds" :month="month" :entries="entries" :disabled="locked" />
      <section v-if="selected.length" class="selection-bar" :aria-label="t('forms.selectedActions')">
        <div class="selection-total">
          <strong role="status">{{ t('forms.selectedBillsTotal', { count: selected.length, amount: totalAmount(selected) }) }}</strong>
          <button type="button" class="ledger-text-btn" :disabled="locked" @click="selectedIds.clear()">{{ t('forms.clearSelection') }}</button>
        </div>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary void-selection" :disabled="locked" @click="voidDialog?.showModal()">
            {{ t('forms.voidSelected') }}
          </button>
          <button type="button" class="ledger-primary repay-selection" :disabled="locked || !payable.length" @click="repaySelected">
            {{ t('forms.paySelected', { count: payable.length, amount: totalAmount(payable) }) }}
          </button>
        </div>
      </section>
      <dialog ref="voidDialog" class="void-dialog" aria-labelledby="void-heading">
        <h2 id="void-heading">{{ t('forms.confirmVoidSelection', { count: selected.length }) }}</h2>
        <p>{{ t('forms.voidSelectionImpact', { amount: totalAmount(selected) }) }}</p>
        <ul>
          <li v-for="entry in selected" :key="entry.id">
            <span>{{ entry.title }}<small>{{ formatMonth(entry.month) }} · {{ entryStatusLabel(entry) }}</small></span>
            <strong>{{ formatMoney(entry.amountCents) }}</strong>
          </li>
        </ul>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary" autofocus @click="voidDialog?.close()">{{ t('forms.cancel') }}</button>
          <button type="button" class="ledger-secondary confirm-void" :disabled="locked || !selected.length" @click="voidSelected">{{ t('forms.confirmVoid') }}</button>
        </div>
      </dialog>
    </template>
  </section>
</template>

<style scoped>
h1 { overflow-wrap: anywhere; }
.undo { justify-self: start; }
.selection-bar { position: sticky; z-index: 2; bottom: 12px; display: grid; gap: 8px;
  padding: 12px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface);
  box-shadow: 0 3px 16px rgb(0 0 0 / 10%); }
.selection-total { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.selection-total strong, .void-dialog strong { font-variant-numeric: tabular-nums; }
.selection-total button { min-height: 32px; }
.void-selection, .confirm-void { color: var(--danger-ink); }
.void-dialog { width: min(26rem, calc(100% - 2rem)); max-height: calc(100% - 2rem); margin: auto; padding: 20px;
  color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
.void-dialog::backdrop { background: var(--dialog-backdrop); }
.void-dialog p { margin: 8px 0; color: var(--sub); }
.void-dialog ul { padding: 0; margin-bottom: 16px; max-height: 38vh; overflow-y: auto; list-style: none; }
.void-dialog li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0;
  border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.void-dialog small { display: block; color: var(--sub); }
@media (max-width: 860px) {
  .selection-bar { bottom: calc(64px + env(safe-area-inset-bottom)); }
}
</style>
