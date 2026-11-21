<script setup lang="ts">
import { computed } from 'vue'
import { formatMoney, t } from '../../i18n'
import type { PetChatDetail, PetChatDetailOption } from './petChatDetails'

const props = defineProps<{ options: PetChatDetailOption[]; disabled: boolean }>()
const selected = defineModel<Set<string>>({ required: true })
const selectedCount = computed(() => props.options.filter(row => selected.value.has(row.id)).length)

function toggleAll(event: Event) {
  const checked = (event.currentTarget as HTMLInputElement).checked
  selected.value = new Set(checked ? props.options.map(row => row.id) : [])
}

function kindLabel(row: PetChatDetail) {
  if (row.kind === 'installment') return t('ledger.installment', { index: row.installmentIndex ?? '—', count: row.installmentCount ?? '—' })
  if (row.kind === 'estimate') return t(row.status === 'estimated' ? 'ledger.estimate' : 'ledger.confirmedEstimate')
  return t('ledger.singlePayment')
}
</script>

<template>
  <p v-if="!options.length" class="no-details">{{ t('pets.chat.noDetails') }}</p>
  <details v-else open class="detail-picker">
    <summary>{{ t('pets.chat.previewDetails', { selected: selectedCount, total: options.length }) }}</summary>
    <fieldset :disabled="disabled" :aria-label="t('pets.chat.shareDetails')">
      <label class="choose-all">
        <input type="checkbox" :checked="selectedCount === options.length" :indeterminate="selectedCount > 0 && selectedCount < options.length" @change="toggleAll" />
        {{ t('pets.chat.selectAllDetails') }}
      </label>
      <div class="bill-list">
        <label v-for="{ id, detail } in options" :key="id" class="bill">
          <input v-model="selected" type="checkbox" :value="id" />
          <span class="bill-text">
            <strong>{{ detail.title }}</strong>
            <small>{{ detail.platform }} · {{ kindLabel(detail) }} · {{ t(detail.status === 'estimated' ? 'ledger.needsConfirmation' : detail.status === 'paid' ? 'ledger.paid' : 'ledger.unpaid') }}</small>
            <small v-if="detail.kind === 'estimate'">{{ t('ledger.estimateBreakdown', {
              total: formatMoney(detail.amountCents + (detail.depositCents ?? 0)), deposit: formatMoney(detail.depositCents ?? 0),
            }) }}</small>
          </span>
          <span class="bill-amount"><small v-if="detail.kind === 'estimate'">{{ t('ledger.balancePayment') }} </small>{{ formatMoney(detail.amountCents) }}</span>
        </label>
      </div>
    </fieldset>
  </details>
</template>

<style scoped>
.detail-picker { min-width: 0; border: 1px solid var(--line); border-radius: 8px; }
.detail-picker summary { padding: 7px 10px; color: var(--green); cursor: pointer; font-size: .82rem; font-weight: 650; }
.detail-picker fieldset { min-width: 0; margin: 0; border: 0; padding: 0 10px; }
.detail-picker input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--green); }
.choose-all, .bill { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.choose-all { min-height: 30px; border-top: 1px solid var(--line); font-size: .81rem; }
.bill-list { max-height: clamp(5rem, 18dvh, 11rem); overflow: auto; overscroll-behavior: contain; }
.bill { min-height: 44px; padding: 5px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; font-size: .83rem; }
.bill-text { flex: 1; min-width: 0; }
.bill-text strong, .bill-text small { display: block; }
.bill small, .no-details { color: var(--sub); font-size: .76rem; }
.bill-amount { max-width: 40%; text-align: end; font-variant-numeric: tabular-nums; }
@media (pointer: coarse) { .detail-picker summary, .choose-all { min-height: 44px; align-content: center; } }
</style>
