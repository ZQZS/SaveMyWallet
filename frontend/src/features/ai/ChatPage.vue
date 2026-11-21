<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { MAX_MONTH, MIN_MONTH } from '../../domain/ledger'
import { t } from '../../i18n'
import ChatWindow from './ChatWindow.vue'

const { data, month, busy, selectMonth, calculateMonth } = useLedgerSession()
const totals = computed(() => data.value && calculateMonth(data.value, month.value))
const monthPicker = ref<HTMLInputElement | null>(null)

function changeMonth(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  if (input.value === month.value) return
  const wasFocused = document.activeElement === input
  selectMonth(input.value)
  input.value = month.value
  if (wasFocused) void nextTick(() => monthPicker.value?.focus({ preventScroll: true }))
}
</script>

<template>
  <ChatWindow v-if="data && totals" :key="month" :month="month" :totals="totals" :floor="data.settings.warningFloorCents">
    <template #month>
      <label class="chat-month">
        {{ t('chat.month') }}
        <input ref="monthPicker" type="month" :value="month" :min="MIN_MONTH" :max="MAX_MONTH" :disabled="busy" @change="changeMonth" />
      </label>
    </template>
  </ChatWindow>
</template>

<style scoped>
.chat-month { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: .8rem; }
.chat-month input { min-width: 0; max-width: 100%; min-height: 36px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); }
@media (pointer: coarse) { .chat-month input { min-height: 44px; } }
@media (max-width: 480px) { .chat-month { flex-basis: 100%; } }
</style>
