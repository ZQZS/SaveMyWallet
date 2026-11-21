<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { isMonth, MAX_MONTH, MIN_MONTH } from '../../domain/ledger'
import { formatMonth, t } from '../../i18n'
import { usePets } from '../pets/usePets'
import ChatDisclosure from './ChatDisclosure.vue'
import ChatWindow from './ChatWindow.vue'

const session = useLedgerSession()
const { data, month, busy, selectMonth, calculateMonth } = session
const totals = computed(() => data.value && calculateMonth(data.value, month.value))
const monthPicker = ref<HTMLInputElement | null>(null)
const personaPicker = ref<HTMLSelectElement | null>(null)
const contextOpen = ref(false)
const { characters, ready, storageError } = usePets()
const preferenceKey = 'savemywallet.chat.persona'
const monthKey = 'savemywallet.chat.month'

// On a fresh launch resume the last menu chat, including a past month.
// An explicit month choice or a ledger operation in this session takes precedence.
if (!session.hasSelectedMonth && !session.writeCount.value) {
  try {
    const saved = localStorage.getItem(monthKey)
    if (saved && isMonth(saved) && saved !== month.value) selectMonth(saved)
  } catch { /* The ledger's current month works without preferences. */ }
}
watch(month, value => {
  try { localStorage.setItem(monthKey, value) } catch { /* The selected month still applies. */ }
}, { immediate: true, flush: 'sync' })

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
  <ChatWindow v-if="data && totals && !waitingForPersona" :key="JSON.stringify([month, persona?.id])" class="menu-chat"
    :pet="persona" :month="month" :totals="totals" :floor="data.settings.warningFloorCents">
    <template #controls>
      <ChatDisclosure v-model:open="contextOpen" name="chatContext" class="context-disclosure"
        :label="t('chat.contextControls')" :value="formatMonth(month) + ' · ' + (persona?.name ?? t('chat.title'))">
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
      </ChatDisclosure>
    </template>
  </ChatWindow>
</template>

<style scoped>
.context-disclosure { flex: 0 1 23rem; min-width: 0; max-width: 100%; }
.chat-context { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, auto); align-items: end; gap: 6px 12px; padding-block: 2px 6px; }
.chat-context label { min-width: 0; display: grid; gap: 3px; font-size: .8rem; }
.chat-persona select { width: 100%; text-overflow: ellipsis; }
.chat-context :is(input, select) { min-width: 0; max-width: 100%; min-height: 36px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; }
@media (pointer: coarse) { .chat-context :is(input, select) { min-height: 44px; } }
@media (max-width: 600px) {
  /* The current chat and month share a title row on small screens. Keep the page heading available to assistive technology. */
  .menu-chat :deep(.chat-heading) { flex-wrap: nowrap; align-items: flex-start; }
  .menu-chat :deep(.chat-heading h1) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .context-disclosure { flex: 1; }
  .context-disclosure :deep(summary) { display: grid; grid-template-columns: minmax(0, 1fr) auto; row-gap: 0; min-height: 44px; }
  .context-disclosure :deep(.panel-value) { grid-area: 2 / 1; margin: 0; }
  .context-disclosure :deep(.panel-chevron) { grid-area: 1 / 2 / span 2; }
}
</style>
