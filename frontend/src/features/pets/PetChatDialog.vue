<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Send, Square, X } from 'lucide-vue-next'
import type { MonthlySummary } from '../../domain/ledger'
import { displayError, formatMoney, formatMonth, locale, t } from '../../i18n'
import { toReminderFacts } from '../../integrations/ai/capabilities'
import { getAiKeyStatus } from '../../integrations/ai/deepseek'
import type { PetCharacter } from './catalog'
import { MAX_PET_MESSAGE_LENGTH, usePetChat } from './usePetChat'

const props = defineProps<{ pet: PetCharacter; month: string; totals: MonthlySummary; floor: number }>()
const emit = defineEmits<{ close: [] }>()
const { messages, draft, pending, error, send, stop } = usePetChat(props.pet, props.month)
const dialog = ref<HTMLDialogElement | null>(null)
const transcript = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const shareSummary = ref(false)
const configured = ref<boolean | null>(null)
const keyError = ref('')
const tooLong = computed(() => Array.from(draft.value.trim()).length > MAX_PET_MESSAGE_LENGTH)
const canSend = computed(() => configured.value === true && !pending.value && !!draft.value.trim() && !tooLong.value)
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
  const facts = shareSummary.value ? toReminderFacts(props.month, props.totals, props.floor) : undefined
  void send(locale.value, facts)
  input.value?.focus({ preventScroll: true })
}

function handleEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!event.repeat) submit()
}

function closeChat() {
  stop()
  dialog.value?.close()
}

function scrollToLatest() {
  const list = transcript.value
  if (list) list.scrollTop = list.scrollHeight
}
watch(() => messages.value.length, scrollToLatest, { flush: 'post' })

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  if (window.matchMedia('(pointer: fine)').matches) input.value?.focus({ preventScroll: true })
  if (messages.value.length) void nextTick(scrollToLatest)
  void checkKey()
})
onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <dialog ref="dialog" class="pet-chat" aria-labelledby="pet-chat-title" aria-describedby="pet-chat-disclosure"
    @cancel="stop" @close="emit('close')">
    <header class="chat-heading">
      <span class="chat-avatar" aria-hidden="true">
        <img v-if="pet.avatar" :src="pet.avatar" alt="" />
        <strong v-else>{{ Array.from(pet.name)[0] }}</strong>
      </span>
      <h2 id="pet-chat-title">{{ t('pets.chat.title', { name: pet.name }) }}</h2>
      <button type="button" class="chat-close" autofocus :aria-label="t('pets.chat.close')" @click="closeChat">
        <X :size="20" aria-hidden="true" />
      </button>
    </header>

    <div ref="transcript" class="chat-history" role="log" :aria-label="t('pets.chat.history')" aria-relevant="additions" tabindex="0">
      <div v-if="pet.greetings[0]" class="chat-message">
        <strong>{{ pet.name }}</strong>
        <p>{{ pet.greetings[0] }}</p>
      </div>
      <div v-for="(message, index) in messages" :key="index" class="chat-message" :class="{ 'from-user': message.role === 'user' }">
        <strong>{{ message.role === 'user' ? t('pets.chat.you') : pet.name }}</strong>
        <p>{{ message.content }}</p>
      </div>
      <p v-if="pending" class="reply-status" role="status">{{ t('pets.chat.wait', { name: pet.name }) }}</p>
    </div>

    <form class="chat-compose" @submit.prevent="submit">
      <p id="pet-chat-disclosure" class="disclosure">{{ t('pets.chat.disclosure') }}</p>
      <label class="share-label">
        <input v-model="shareSummary" type="checkbox" :disabled="pending" />
        {{ t('pets.chat.share', { month: formatMonth(month) }) }}
      </label>
      <p v-if="shareSummary" class="shared-facts">
        {{ t('pets.chat.figures', { balance: formatMoney(totals.balance), due: formatMoney(totals.due), floor: formatMoney(floor) }) }}
      </p>
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
          :readonly="pending" :aria-invalid="tooLong" :aria-label="t('pets.chat.message')" :placeholder="t('pets.chat.placeholder', { name: pet.name })"
          @keydown.enter="handleEnter" />
        <button v-if="pending" type="button" class="stop-button" @click="stop">
          <Square :size="15" aria-hidden="true" />{{ t('pets.chat.stop') }}
        </button>
        <button v-else type="submit" class="send-button" :disabled="!canSend">
          <Send :size="16" aria-hidden="true" />{{ t(error ? 'pets.chat.resend' : 'pets.chat.send') }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.pet-chat { width: min(35rem, calc(100% - 24px)); height: min(36rem, calc(100% - 24px)); max-height: calc(100dvh - 24px); margin: auto; padding: 0; overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); color: var(--ink); }
.pet-chat[open] { display: flex; flex-direction: column; }
.pet-chat::backdrop { background: #202e2766; }
.chat-heading { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line); }
.chat-avatar { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--soft); color: var(--green); overflow: hidden; }
.chat-avatar img { width: 100%; height: 100%; object-fit: contain; }
.chat-heading h2 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.1rem; }
.chat-close { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: var(--sub); }
.chat-close:hover { background: var(--soft); }
.chat-history { flex: 1 1 0; min-height: 5rem; padding: 16px; overflow: auto; overscroll-behavior: contain; background: var(--paper); }
.chat-message { width: fit-content; max-width: 88%; margin-bottom: 12px; overflow-wrap: anywhere; }
.chat-message strong { display: block; margin: 0 4px 3px; color: var(--sub); font-size: .75rem; }
.chat-message p { padding: 8px 12px; border: 1px solid var(--line); border-radius: 3px 12px 12px; background: var(--surface); line-height: 1.5; white-space: pre-wrap; }
.from-user { margin-inline-start: auto; }
.from-user strong { text-align: end; }
.from-user p { background: var(--soft); border-radius: 12px 3px 12px 12px; }
.chat-compose { flex: none; display: grid; gap: 6px; padding: 12px 14px; border-top: 1px solid var(--line); }
.disclosure, .reply-status, .shared-facts { color: var(--sub); font-size: .79rem; line-height: 1.45; }
.share-label { display: flex; align-items: center; gap: 7px; width: fit-content; min-height: 30px; font-size: .85rem; cursor: pointer; }
.share-label input { width: 16px; height: 16px; margin: 0; accent-color: var(--green); }
.shared-facts { padding: 0 0 4px 23px; }
.compose-row { display: flex; align-items: flex-end; gap: 8px; }
.compose-row textarea { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--ink); font: inherit; line-height: 1.4; resize: none; }
.compose-row textarea:focus-visible, .chat-history:focus-visible { outline: 2px solid #3b895e; outline-offset: -2px; }
.send-button, .stop-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; padding: 6px 12px; border-radius: 9px; font-size: .87rem; font-weight: 650; }
.send-button { border: 1px solid var(--green); color: var(--surface); background: var(--green); }
.send-button:disabled { opacity: .5; }
.stop-button { border: 1px solid var(--line); color: var(--green); background: var(--soft); }
.chat-error, .setup-hint { overflow-wrap: anywhere; font-size: .85rem; line-height: 1.45; }
.chat-error { color: #873627; }
.pet-chat a, .text-action { color: var(--green); text-decoration: underline; text-underline-offset: 2px; }
.text-action { border: 0; padding: 3px; background: transparent; }
@media (pointer: coarse) { .share-label { min-height: 44px; } }
@media (max-width: 440px) {
  .pet-chat { width: calc(100% - 12px); height: min(38rem, calc(100% - 12px)); max-height: calc(100dvh - 12px); }
  .chat-compose, .chat-heading { padding-inline: 10px; }
}
</style>
