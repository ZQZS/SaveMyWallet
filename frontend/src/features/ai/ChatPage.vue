<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { MAX_MONTH, MIN_MONTH } from '../../domain/ledger'
import { t } from '../../i18n'
import { usePets } from '../pets/usePets'
import ChatWindow from './ChatWindow.vue'

const { data, month, busy, selectMonth, calculateMonth } = useLedgerSession()
const totals = computed(() => data.value && calculateMonth(data.value, month.value))
const monthPicker = ref<HTMLInputElement | null>(null)
const personaPicker = ref<HTMLSelectElement | null>(null)
const { characters, ready, storageError } = usePets()
const preferenceKey = 'savemywallet.chat.persona'

function readPersona() {
  try { return localStorage.getItem(preferenceKey) ?? '' } catch { return '' }
}

const personaId = ref(readPersona())
const persona = computed(() => characters.value.find(character => character.id === personaId.value))
const waitingForPersona = computed(() => !!personaId.value && !persona.value && !ready.value)

function selectPersona(id: string) {
  personaId.value = id
  try {
    if (id) localStorage.setItem(preferenceKey, id)
    else localStorage.removeItem(preferenceKey)
  } catch { /* The choice still applies for this visit. */ }
}

watch([ready, storageError, persona], () => {
  if (ready.value && !storageError.value && personaId.value && !persona.value) selectPersona('')
}, { immediate: true })

function changePersona(event: Event) {
  const select = event.currentTarget as HTMLSelectElement
  const wasFocused = document.activeElement === select
  selectPersona(select.value)
  if (wasFocused) void nextTick(() => personaPicker.value?.focus({ preventScroll: true }))
}

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
  <p v-if="waitingForPersona" class="loading" role="status">{{ t('pets.picker.loading') }}</p>
  <p v-if="storageError" class="alert" role="status">{{ t('pets.picker.storageUnavailable') }}</p>
  <ChatWindow v-if="data && totals && !waitingForPersona" :key="JSON.stringify([month, persona?.id])"
    :pet="persona" :month="month" :totals="totals" :floor="data.settings.warningFloorCents">
    <template #controls>
      <div class="chat-context">
        <label class="chat-persona">
          {{ t('chat.persona') }}
          <select ref="personaPicker" name="chatPersona" :value="persona?.id ?? ''" @change="changePersona">
            <option value="">{{ t('chat.noPersona') }}</option>
            <option v-for="character in characters" :key="character.id" :value="character.id">{{ character.name }}</option>
          </select>
        </label>
        <label class="chat-month">
          {{ t('chat.month') }}
          <input ref="monthPicker" type="month" :value="month" :min="MIN_MONTH" :max="MAX_MONTH" :disabled="busy" @change="changeMonth" />
        </label>
      </div>
    </template>
  </ChatWindow>
</template>

<style scoped>
.chat-context { display: flex; align-items: end; gap: 6px 12px; max-width: 100%; }
.chat-context label { min-width: 0; display: grid; gap: 3px; font-size: .8rem; }
.chat-persona select { width: clamp(10rem, 18vw, 15rem); text-overflow: ellipsis; }
.chat-context :is(input, select) { min-width: 0; max-width: 100%; min-height: 36px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; }
@media (pointer: coarse) { .chat-context :is(input, select) { min-height: 44px; } }
@media (max-width: 600px) {
  .chat-context { flex: 1 1 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto); }
  .chat-persona select { width: 100%; }
}
</style>
