<script lang="ts">
// A dismissed reminder belongs to the month, including when the user leaves this page or changes pets.
const dismissedReminders = new Map<string, 'lowBalance' | 'pendingEstimates'>()
</script>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowDown, MessageCircle, Repeat2, X } from 'lucide-vue-next'
import type { MonthlySummary } from '../../domain/ledger'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import PetPickerDialog from './PetPickerDialog.vue'
import PetChatDialog from './PetChatDialog.vue'
import { usePets } from './usePets'

const props = defineProps<{ month: string; totals: MonthlySummary; floor: number }>()
const emit = defineEmits<{ details: [] }>()
const { enabled, ready, activePet } = usePets()
const pickerOpen = ref(false)
const chatOpen = ref(false)
const petButton = ref<HTMLButtonElement | null>(null)
const reminderHidden = ref(false)
const greetingIndex = ref(-1)
const showingGreeting = ref(false)
const greetingPose = ref(false)
let poseTimer: number | undefined

const pendingCount = computed(() => props.totals.groups.reduce((sum, group) =>
  sum + group.entries.filter(entry => !entry.voided && entry.status === 'estimated').length, 0))
const reminder = computed(() => {
  if (props.totals.balance < props.floor) return 'lowBalance'
  if (pendingCount.value > 0) return 'pendingEstimates'
  return null
})
watch([() => props.month, reminder], ([month, kind]) => {
  reminderHidden.value = kind !== null && dismissedReminders.get(month) === kind
  if (!reminderHidden.value) dismissedReminders.delete(month)
  if (kind && !reminderHidden.value) {
    showingGreeting.value = false
    greetingPose.value = false
  }
}, { immediate: true })

function resetGreeting() {
  window.clearTimeout(poseTimer)
  greetingPose.value = false
  showingGreeting.value = false
  greetingIndex.value = -1
}
watch([() => activePet.value?.id, locale, () => props.month, enabled], resetGreeting)
onUnmounted(() => window.clearTimeout(poseTimer))

function greet() {
  const greetings = activePet.value?.greetings ?? []
  greetingIndex.value = greetings.length ? (greetingIndex.value + 1) % greetings.length : -1
  showingGreeting.value = true
  greetingPose.value = true
  window.clearTimeout(poseTimer)
  poseTimer = window.setTimeout(() => { greetingPose.value = false }, 650)
}

const speech = computed(() => {
  const pet = activePet.value
  if (!pet) return ''
  if (showingGreeting.value) return pet.greetings[greetingIndex.value] || t('pets.ledger.greeting')
  const kind = reminder.value
  if (reminderHidden.value || !kind) return ''
  const values = { month: formatMonth(props.month), amount: formatMoney(props.floor - props.totals.balance), count: pendingCount.value }
  const line = pet[kind]
  return line
    ? line.replace(/\{(month|amount|count)\}/g, (_match, key: keyof typeof values) => String(values[key]))
    : t('pets.ledger.' + kind, values)
})

function dismiss() {
  if (!showingGreeting.value && reminder.value) {
    dismissedReminders.set(props.month, reminder.value)
    reminderHidden.value = true
  }
  showingGreeting.value = false
  greetingPose.value = false
  nextTick(() => petButton.value?.focus({ preventScroll: true }))
}
</script>

<template>
  <aside v-if="enabled && ready && activePet" class="ledger-pet" :aria-label="activePet.name">
    <button ref="petButton" type="button" class="pet-identity" :aria-label="t('pets.ledger.greet', { name: activePet.name })"
      :title="t('pets.ledger.greet', { name: activePet.name })" @click="greet">
      <span :key="greetingIndex" class="portrait" :class="{ waving: greetingPose, imported: activePet.imported }">
        <img v-if="activePet.avatar" :src="(greetingPose && activePet.greetAvatar) || activePet.avatar" alt="" />
        <span v-else aria-hidden="true">{{ Array.from(activePet.name)[0] }}</span>
      </span>
      <strong>{{ activePet.name }}</strong>
    </button>
    <div v-if="speech" class="pet-bubble">
      <div class="bubble-content">
        <p role="status">{{ speech }}</p>
        <button v-if="!showingGreeting" type="button" class="details-button" @click="emit('details')">
          {{ t('pets.ledger.details') }}<ArrowDown :size="14" aria-hidden="true" />
        </button>
      </div>
      <button type="button" class="dismiss" :aria-label="t('pets.ledger.dismiss')" @click="dismiss">
        <X :size="16" aria-hidden="true" />
      </button>
    </div>
    <div class="pet-actions">
      <button type="button" class="chat-button" aria-haspopup="dialog" @click="chatOpen = true">
        <MessageCircle :size="16" aria-hidden="true" />{{ t('pets.chat.open') }}
      </button>
      <button type="button" class="switch-pet" aria-haspopup="dialog" @click="pickerOpen = true">
        <Repeat2 :size="16" aria-hidden="true" />{{ t('pets.ledger.switch') }}
      </button>
    </div>
    <PetPickerDialog v-if="pickerOpen" @close="pickerOpen = false" />
    <PetChatDialog v-if="chatOpen" :key="JSON.stringify([activePet.id, month])" :pet="activePet" :month="month"
      :totals="totals" :floor="floor" @close="chatOpen = false" />
  </aside>
</template>

<style scoped>
.ledger-pet { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 16px; border: 1px solid var(--line); border-top: 0; border-radius: 0 0 16px 16px; }
.ledger-pet button { color: var(--green); }
.pet-identity, .chat-button, .switch-pet, .details-button, .dismiss { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 8px; background: transparent; }
.pet-identity { min-width: 0; max-width: 100%; padding: 2px 4px; text-align: start; }
.pet-identity strong { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .88rem; }
.portrait { flex: none; display: grid; place-items: center; width: 48px; height: 48px; border-radius: 12px; font-weight: 700; }
.portrait img { width: 100%; height: 100%; object-fit: contain; }
.portrait.imported { overflow: hidden; background: var(--soft); }
.portrait.imported img { object-fit: cover; }
.pet-bubble { flex: 0 1 auto; min-width: 0; max-width: 34rem; display: flex; align-items: flex-start; padding: 5px 2px 5px 12px; border-radius: 12px; background: var(--soft); }
.bubble-content { min-width: 0; padding: 4px 0; }
.bubble-content p { max-height: 12rem; overflow: auto; overflow-wrap: anywhere; white-space: pre-line; font-size: .88rem; line-height: 1.5; }
.dismiss { flex: none; justify-content: center; width: 36px; height: 32px; }
.details-button { padding: 4px 0; font-size: .8rem; font-weight: 650; }
.pet-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-inline-start: auto; }
.switch-pet, .chat-button { min-height: 40px; padding: 4px 8px; font-size: .82rem; }
.chat-button { background: var(--soft); font-weight: 650; }
.switch-pet:hover, .pet-identity:hover, .dismiss:hover { background: var(--soft); }
.details-button:hover { text-decoration: underline; }
@media (max-width: 650px) {
  .ledger-pet { gap: 3px 8px; padding: 5px 10px; }
  .pet-bubble { order: 1; flex-basis: 100%; max-width: 100%; margin-bottom: 4px; justify-content: space-between; }
}
@media (pointer: coarse) {
  .dismiss, .switch-pet, .chat-button, .details-button { min-height: 44px; }
  .dismiss { width: 44px; }
}
@media (prefers-reduced-motion: no-preference) {
  .portrait.waving { animation: greet .45s ease-out; }
  @keyframes greet { 50% { transform: translateY(-3px) rotate(-6deg); } }
}
</style>
