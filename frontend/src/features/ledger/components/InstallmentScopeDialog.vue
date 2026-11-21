<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Entry } from '../../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../../i18n'

const props = defineProps<{ entry: Entry; periods: Entry[] | null; busy: boolean }>()
const emit = defineEmits<{
  apply: [entry: Entry, voided: boolean, whole: boolean]
  dismiss: []
}>()
const dialog = ref<HTMLDialogElement | null>(null)
onMounted(() => dialog.value?.showModal())

const groupActions = computed(() => {
  const periods = props.periods ?? []
  return [true, false].map(voided => {
    const affected = periods.filter(period => Boolean(period.voided) !== voided)
    return { voided, count: affected.length, paid: affected.filter(period => period.status === 'paid').length }
  }).filter(action => action.count > 0)
})

function apply(voided: boolean, whole: boolean) {
  if (props.busy) return
  dialog.value?.close()
  emit('apply', props.entry, voided, whole)
}
</script>

<template>
  <dialog ref="dialog" class="scope-dialog" aria-labelledby="scope-heading" @close="emit('dismiss')">
    <h2 id="scope-heading">{{ entry.title }}</h2>
    <div class="scope-section">
      <p>{{ formatMonth(entry.month) }} · {{ t('ledger.installment', { index: entry.installmentIndex ?? '—', count: entry.installmentCount ?? '—' }) }} ·
        {{ formatMoney(entry.amountCents) }} · {{ t(entry.status === 'paid' ? 'ledger.paid' : 'ledger.unpaid') }}</p>
      <button type="button" :disabled="busy" @click="apply(!entry.voided, false)">
        {{ t(entry.voided ? 'ledger.restorePeriod' : 'ledger.voidPeriod') }}
      </button>
    </div>
    <div v-if="periods?.length" class="scope-section">
      <h3>{{ t('ledger.installmentPlan') }}</h3>
      <p>{{ t('ledger.planRange', { start: formatMonth(periods[0].month), end: formatMonth(periods[periods.length - 1].month), count: periods.length }) }}</p>
      <p v-if="!entry.installmentId">{{ t('ledger.legacyPlanMatch') }}</p>
      <div v-for="action in groupActions" :key="String(action.voided)" class="scope-action">
        <button type="button" :disabled="busy" :aria-describedby="'scope-impact-' + action.voided" @click="apply(action.voided, true)">
          {{ t(action.voided ? 'ledger.voidPlan' : 'ledger.restorePlan') }}
        </button>
        <small :id="'scope-impact-' + action.voided">{{ t('ledger.planImpact', { count: action.count, paid: action.paid }) }}</small>
      </div>
    </div>
    <p v-else class="scope-section">{{ t('error.INSTALLMENT_GROUP_UNAVAILABLE') }}</p>
    <button class="cancel" type="button" @click="dialog?.close()">{{ t('forms.cancel') }}</button>
  </dialog>
</template>

<style scoped>
.scope-dialog {
  width: min(27rem, calc(100% - 2rem)); max-height: calc(100% - 2rem); overflow-y: auto;
  margin: auto; padding: 20px; border: 1px solid var(--line); border-radius: 15px;
  background: var(--surface); color: var(--ink); overflow-wrap: anywhere;
}
.scope-dialog::backdrop { background: var(--dialog-backdrop); }
.scope-dialog h2 { font-size: 1.15rem; }
.scope-section { display: grid; gap: 8px; padding-block: 14px; border-bottom: 1px solid var(--line); }
.scope-section h3 { font-size: 1rem; }
.scope-section p, .scope-section small, p.scope-section { color: var(--sub); font-size: .85rem; }
.scope-dialog button {
  min-height: 44px; justify-self: start; padding: 6px 13px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--soft); color: var(--green); font-weight: 650;
}
.scope-action { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.scope-dialog .cancel { display: block; margin: 12px 0 0 auto; background: transparent; color: var(--ink); }
</style>
