<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MessageCircle, MessageSquarePlus, Send, Square, X } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { MonthlySummary } from '../../domain/ledger'
import { displayError, formatMoney, formatMonth, locale, t } from '../../i18n'
import { toReminderFacts } from '../../integrations/ai/capabilities'
import { getAiKeyStatus } from '../../integrations/ai/deepseek'
import type { PetCharacter } from '../pets/catalog'
import PetChatDetailPicker from '../pets/PetChatDetailPicker.vue'
import { petChatDetailOptions, selectedPetChatDetails, selectedPetChatOptions } from '../pets/petChatDetails'
import { MAX_PET_MESSAGE_LENGTH, useGeneralChat, usePetChat } from '../pets/usePetChat'
import { useReminders } from '../reminders/useReminders'
import { useLedgerActionReview } from './useLedgerActionReview'

const props = defineProps<{ pet?: PetCharacter; month: string; totals: MonthlySummary; floor: number }>()
const emit = defineEmits<{ close: [] }>()
const session = useLedgerSession()
const reminders = useReminders()
const { review, confirm, decline, forTurn } = useLedgerActionReview(session,
  input => reminders.create({ ...input, pet: props.pet }),
  input => reminders.test({ ...input, pet: props.pet }))
const { messages, draft, pending, error, send, stop, conversations, activeConversationId, newChat, selectChat } =
  props.pet ? usePetChat(props.pet, props.month) : useGeneralChat(props.month)
const speaker = computed(() => props.pet?.name ?? t('chat.assistant'))
const root = ref<HTMLElement | null>(null)
const transcript = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const reviewHeading = ref<HTMLElement | null>(null)
const shareMode = ref<'none' | 'summary' | 'details'>('none')
const detailOptions = computed(() => petChatDetailOptions(props.month, props.totals, true))
const selectedIds = ref(new Set<string>())
let initializedSelection = false
const detailAttachment = computed(() => shareMode.value === 'details'
  ? selectedPetChatDetails(props.month, detailOptions.value, selectedIds.value)
  : undefined)
const configured = ref<boolean | null>(null)
const keyError = ref('')
const tooLong = computed(() => Array.from(draft.value.trim()).length > MAX_PET_MESSAGE_LENGTH)
const canSend = computed(() => configured.value === true && !pending.value && !session.busy.value && !session.needsReload.value && !!draft.value.trim() && !tooLong.value
  && (!detailAttachment.value || detailAttachment.value.entries.length > 0))
const keyNeedsAttention = computed(() => ['AI_KEY_MISSING', 'AI_KEY_INVALID', 'AI_AUTH'].includes(error.value))
let opener: HTMLElement | null = null

async function checkKey() {
  configured.value = null
  keyError.value = ''
  try {
    configured.value = await getAiKeyStatus()
  } catch (cause) {
    keyError.value = displayError(cause)
  }
}

function submit() {
  if (!canSend.value) return
  const facts = shareMode.value !== 'none' ? toReminderFacts(props.month, props.totals, props.floor) : undefined
  const ids = shareMode.value === 'details'
    ? selectedPetChatOptions(props.month, detailOptions.value, selectedIds.value).map(row => row.id) : []
  void send(locale.value, facts, detailAttachment.value, forTurn(props.month, ids))
  input.value?.focus({ preventScroll: true })
}

function handleEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!event.repeat) submit()
}

function closeChat() {
  stop()
  if (root.value instanceof HTMLDialogElement) root.value.close()
}

function scrollToLatest() {
  const list = transcript.value
  if (list) list.scrollTop = list.scrollHeight
}
watch(shareMode, mode => {
  if (mode === 'details' && !initializedSelection) {
    selectedIds.value = new Set(detailOptions.value.filter(row => !row.detail.voided).map(row => row.id))
    initializedSelection = true
  }
}, { flush: 'sync' })
watch(detailOptions, (rows, before) => {
  const oldStates = new Map(before.map(row => [row.id, Boolean(row.detail.voided)]))
  selectedIds.value = new Set(rows.filter(row => selectedIds.value.has(row.id)
    && oldStates.get(row.id) === Boolean(row.detail.voided)).map(row => row.id))
}, { flush: 'sync' })
function resetSharing() {
  shareMode.value = 'none'
  selectedIds.value = new Set()
  initializedSelection = false
}
watch(activeConversationId, resetSharing, { flush: 'sync' })
watch([() => messages.value.length, activeConversationId], scrollToLatest, { flush: 'post' })
watch(review, action => {
  if (action) reviewHeading.value?.focus({ preventScroll: true })
}, { flush: 'post' })

function startChat() {
  // New chat may reuse the current empty conversation and keep its ID.
  resetSharing()
  newChat()
  input.value?.focus({ preventScroll: true })
}

onMounted(() => {
  if (root.value instanceof HTMLDialogElement) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.value.showModal()
    if (window.matchMedia('(pointer: fine)').matches) input.value?.focus({ preventScroll: true })
  }
  if (messages.value.length) void nextTick(scrollToLatest)
  void checkKey()
})
onBeforeUnmount(() => {
  if (root.value instanceof HTMLDialogElement && root.value.open) root.value.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <component :is="pet ? 'dialog' : 'section'" ref="root" class="chat-window" :class="{ 'pet-dialog': pet, 'chat-page': !pet }"
    aria-labelledby="chat-title" :aria-describedby="review ? undefined : 'chat-disclosure'"
    @cancel="stop" @close="emit('close')">
    <header class="chat-heading">
      <span class="chat-avatar" aria-hidden="true">
        <MessageCircle v-if="!pet" :size="23" />
        <img v-else-if="pet.avatar" :src="pet.avatar" alt="" />
        <strong v-else>{{ Array.from(pet.name)[0] }}</strong>
      </span>
      <h2 v-if="pet" id="chat-title">{{ t('pets.chat.title', { name: pet.name }) }}</h2>
      <h1 v-else id="chat-title">{{ t('chat.title') }}</h1>
      <button v-if="pet" type="button" class="chat-close" autofocus :aria-label="t('pets.chat.close')" @click="closeChat">
        <X :size="20" aria-hidden="true" />
      </button>
      <slot v-else name="month" />
    </header>
    <nav class="thread-bar" :aria-label="t('pets.chat.chooseThread')">
      <label>
        <span>{{ t('pets.chat.chooseThread') }}</span>
        <select :value="activeConversationId" @change="selectChat(Number(($event.currentTarget as HTMLSelectElement).value))">
          <option v-for="thread in conversations" :key="thread.id" :value="thread.id">
            {{ thread.title || t('pets.chat.untitled', { number: thread.id }) }}
          </option>
        </select>
      </label>
      <button type="button" class="new-thread" @click="startChat">
        <MessageSquarePlus :size="16" aria-hidden="true" />{{ t('pets.chat.newThread') }}
      </button>
    </nav>

    <div ref="transcript" class="chat-history" role="log" :aria-label="t('pets.chat.history')" aria-relevant="additions" tabindex="0">
      <div v-if="pet?.greetings[0]" class="chat-message">
        <strong>{{ pet.name }}</strong>
        <p>{{ pet.greetings[0] }}</p>
      </div>
      <p v-if="!pet && !messages.length" class="empty-chat">{{ t('chat.empty') }}</p>
      <div v-for="(message, index) in messages" :key="index" class="chat-message" :class="{ 'from-user': message.role === 'user' }">
        <strong>{{ message.role === 'user' ? t('pets.chat.you') : speaker }}</strong>
        <p>{{ message.content }}</p>
      </div>
      <p v-if="pending && !review" class="reply-status" role="status">{{ t('pets.chat.wait', { name: speaker }) }}</p>
    </div>

    <section v-if="review" class="action-review" aria-labelledby="action-review-title">
      <h3 id="action-review-title" ref="reviewHeading" tabindex="-1">{{ t('chat.action.review', { action: t('chat.action.' + review.name) }) }}</h3>
      <ul>
        <li v-for="(line, index) in review.lines" :key="index">{{ line }}</li>
      </ul>
      <div class="review-buttons">
        <button type="button" class="action-decline stop-button" @click="decline">{{ t('chat.action.decline') }}</button>
        <button type="button" class="action-confirm send-button" @click="($event.detail < 2) && confirm()">{{ t('chat.action.confirm') }}</button>
      </div>
    </section>
    <form v-else class="chat-compose" @submit.prevent="submit">
      <p id="chat-disclosure" class="disclosure">{{ t(pet ? 'pets.chat.disclosure' : 'chat.disclosure') }}</p>
      <button v-if="session.needsReload.value" type="button" class="text-action" :disabled="session.busy.value" @click="session.retryRead">{{ t('app.retry') }}</button>
      <fieldset class="share-options" :disabled="pending">
        <legend>{{ t('pets.chat.share', { month: formatMonth(month) }) }}</legend>
        <div class="share-choices">
          <label v-for="mode in (['none', 'summary', 'details'] as const)" :key="mode">
            <input v-model="shareMode" type="radio" name="chat-sharing" :value="mode" />
            <span>{{ t(mode === 'details' ? 'pets.chat.shareDetails' : mode === 'summary' ? 'pets.chat.shareSummary' : 'pets.chat.shareNone') }}</span>
          </label>
        </div>
      </fieldset>
      <p v-if="shareMode !== 'none'" class="shared-facts">
        {{ t('pets.chat.figures', { balance: formatMoney(totals.balance), due: formatMoney(totals.due), floor: formatMoney(floor) }) }}
      </p>
      <PetChatDetailPicker v-if="shareMode === 'details'" v-model="selectedIds" :options="detailOptions" :disabled="pending" />
      <p v-if="shareMode === 'details' && detailOptions.length && !detailAttachment?.entries.length" class="disclosure">{{ t('pets.chat.chooseDetails') }}</p>
      <div v-if="keyError" class="chat-error" role="alert">
        {{ keyError }}
        <button type="button" class="text-action" @click="checkKey">{{ t('pets.chat.checkAgain') }}</button>
      </div>
      <p v-else-if="configured === null" class="disclosure" role="status">{{ t('aiSettings.loading') }}</p>
      <div v-else-if="!configured" class="setup-hint">
        {{ t('error.AI_KEY_MISSING') }}
        <RouterLink :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <div v-if="error && configured" class="chat-error" role="alert">
        {{ displayError(new Error(error)) }}
        <RouterLink v-if="keyNeedsAttention" :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <p v-if="tooLong" class="chat-error" role="alert">{{ t('pets.chat.limit', { count: MAX_PET_MESSAGE_LENGTH }) }}</p>
      <div class="compose-row">
        <textarea ref="input" v-model="draft" rows="2" enterkeyhint="send" :maxlength="MAX_PET_MESSAGE_LENGTH * 2"
          :readonly="pending" :aria-invalid="tooLong" :aria-label="t('pets.chat.message')"
          :placeholder="shareMode === 'details' ? t('pets.chat.detailsPlaceholder') : t('pets.chat.placeholder', { name: speaker })"
          @keydown.enter="handleEnter" />
        <button v-if="pending" type="button" class="stop-button" @click="stop">
          <Square :size="15" aria-hidden="true" />{{ t('pets.chat.stop') }}
        </button>
        <button v-else type="submit" class="send-button" :disabled="!canSend">
          <Send :size="16" aria-hidden="true" />{{ t(error ? 'pets.chat.resend' : 'pets.chat.send') }}
        </button>
      </div>
    </form>
  </component>
</template>

<style scoped>
.chat-window { min-width: 0; margin: auto; padding: 0; overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); color: var(--ink); }
.pet-dialog { width: min(37rem, calc(100% - 24px)); height: min(42rem, calc(100% - 24px)); max-height: calc(100dvh - 24px); }
.pet-dialog[open], .chat-page { display: flex; flex-direction: column; }
.pet-dialog::backdrop { background: var(--dialog-backdrop); }
.chat-page { width: 100%; max-width: 54rem; height: clamp(27rem, calc(100dvh - 9rem), 48rem); }
.chat-heading { --focus-ring: var(--hero-ink); flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 14px;
  background: var(--hero-bg); color: var(--hero-ink); border-bottom: 1px solid var(--line); }
.chat-avatar { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--soft); color: var(--green); overflow: hidden; }
.chat-avatar img { width: 100%; height: 100%; object-fit: contain; }
.chat-heading h1, .chat-heading h2 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.1rem; }
.chat-page .chat-heading { flex-wrap: wrap; }
.empty-chat { margin: 1rem auto; max-width: 28em; text-align: center; color: var(--sub); font-size: .9rem; line-height: 1.6; }
.chat-close { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: inherit; }
.chat-close:hover { box-shadow: inset 0 0 0 1px currentColor; }
.thread-bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 14px; border-bottom: 1px solid var(--line); }
.thread-bar label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.thread-bar label span { flex: none; color: var(--sub); font-size: .78rem; }
.thread-bar select { flex: 1; width: 100%; min-width: 0; min-height: 34px; padding: 3px 5px; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; text-overflow: ellipsis; font-size: .86rem; }
.new-thread { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 3px 6px; white-space: nowrap; background: transparent; color: var(--green); border: 0; border-radius: 6px; font-size: .84rem; font-weight: 650; }
.new-thread:hover { background: var(--soft); }
.chat-history { flex: 1 1 0; min-height: 5rem; padding: 16px; overflow: auto; overscroll-behavior: contain;
  background-color: var(--paper); background-image: var(--page-background-image); background-size: var(--page-background-size); background-position: center; }
.chat-message { width: fit-content; max-width: 88%; margin-bottom: 12px; overflow-wrap: anywhere; }
.chat-message strong { display: block; margin: 0 4px 3px; color: var(--sub); font-size: .75rem; }
.chat-message p { padding: 8px 12px; border: 1px solid var(--line); border-radius: 3px 12px 12px; background: var(--surface); line-height: 1.5; white-space: pre-wrap; }
.chat-message:not(.from-user) p { border-inline-start: 3px solid var(--green); }
.from-user { margin-inline-start: auto; }
.from-user strong { text-align: end; }
.from-user p { background: var(--hero-bg); color: var(--hero-ink); border-radius: 12px 3px 12px 12px; }
.chat-compose { flex: none; display: grid; gap: 6px; padding: 12px 14px; border-top: 1px solid var(--line); }
.action-review { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; max-height: 68%; padding: 12px 14px; border-top: 1px solid var(--line); background: var(--surface); }
.action-review h3 { font-size: 1rem; overflow-wrap: anywhere; }
.action-review ul { margin: 0; min-height: 0; padding-inline-start: 1.25rem; overflow: auto; overflow-wrap: anywhere; line-height: 1.5; font-size: .9rem; }
.review-buttons { display: flex; flex: none; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.disclosure, .reply-status, .shared-facts { color: var(--sub); font-size: .79rem; line-height: 1.45; }
.share-options { min-width: 0; margin: 0; border: 0; padding: 0; }
.share-options legend { margin: 0; padding: 0; color: var(--sub); font-size: .79rem; }
.share-choices { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; }
.share-choices label { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; font-size: .82rem; cursor: pointer; }
.share-choices input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent-solid); }
.compose-row { display: flex; align-items: flex-end; gap: 8px; }
.compose-row textarea { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--ink); font: inherit; line-height: 1.4; resize: none; }
.compose-row textarea::placeholder { color: var(--sub); opacity: 1; }
.compose-row textarea:focus-visible, .chat-history:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
.send-button, .stop-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; padding: 6px 12px; border-radius: 9px; font-size: .87rem; font-weight: 650; }
.send-button { border: 1px solid var(--accent-solid); color: var(--on-accent); background: var(--accent-solid); }
.send-button:disabled { opacity: .5; }
.stop-button { border: 1px solid var(--line); color: var(--green); background: var(--soft); }
.chat-error, .setup-hint { overflow-wrap: anywhere; font-size: .85rem; line-height: 1.45; }
.chat-error { color: var(--danger-ink); }
.chat-window a, .text-action { color: var(--green); text-decoration: underline; text-underline-offset: 2px; }
.text-action { border: 0; padding: 3px; background: transparent; }
@media (pointer: coarse) { .share-choices label, .thread-bar select, .new-thread { min-height: 44px; } }
@media (max-width: 440px) {
  .pet-dialog { width: calc(100% - 12px); height: min(44rem, calc(100% - 12px)); max-height: calc(100dvh - 12px); }
  .chat-compose, .chat-heading, .thread-bar { padding-inline: 10px; }
}
@media (max-width: 860px) {
  .chat-page { height: max(27rem, calc(100dvh - 9.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))); }
}
</style>
