<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ImagePlus } from 'lucide-vue-next'
import { displayError, formatMonth, t } from '../../i18n'
import { chooseAiImage, parseNotice, releaseAiImage, type SelectedAiImage } from '../../integrations/ai/deepseek'
import { useAssistantRequest } from './useAssistantRequest'
import type { NoticeDraft } from './noticeMatch'

const props = defineProps<{ referenceMonth: string; locked: boolean }>()
const emit = defineEmits<{ review: [draft: NoticeDraft, source: { text: string; image: string }] }>()
const { pending, error, run, cancel } = useAssistantRequest()
const mode = ref<'text' | 'image'>('text')
const message = ref('')
const image = ref<SelectedAiImage | null>(null)
const previewState = ref<'loading' | 'ready' | 'failed'>('loading')
const choosing = ref(false)
const pickerError = ref('')
const hasSource = computed(() => mode.value === 'text' ? !!message.value.trim() : !!image.value && previewState.value === 'ready')
let mounted = true

function discardImage() {
  if (image.value) void releaseAiImage(image.value.imageToken).catch(() => {})
  image.value = null
  previewState.value = 'loading'
  pickerError.value = ''
}

function changeMode(value: 'text' | 'image') {
  if (mode.value === value || pending.value || choosing.value) return
  discardImage()
  mode.value = value
  error.value = ''
}

async function choose() {
  if (choosing.value || pending.value || props.locked) return
  choosing.value = true
  pickerError.value = ''
  try {
    const selected = await chooseAiImage()
    if (!selected) return
    if (!mounted) {
      void releaseAiImage(selected.imageToken).catch(() => {})
      return
    }
    discardImage()
    image.value = selected
    error.value = ''
  } catch (cause) {
    if (mounted) pickerError.value = displayError(cause)
  } finally {
    choosing.value = false
  }
}

function review(draft: NoticeDraft) {
  emit('review', draft, {
    text: mode.value === 'text' ? message.value.trim() : '',
    image: mode.value === 'image' ? image.value?.previewUrl ?? '' : '',
  })
}

function send() {
  if (props.locked || pending.value || choosing.value || !hasSource.value) return
  const source = mode.value === 'text' ? { text: message.value.trim() } : { imageToken: image.value!.imageToken }
  void run(signal => parseNotice(source, props.referenceMonth, signal), review)
}

function manual() {
  if (props.locked || pending.value || choosing.value) return
  review({ platformHint: null, title: null, month: null, amountCents: null, totalCents: null, depositCents: null })
}

onBeforeUnmount(() => { mounted = false; discardImage() })
</script>

<template>
  <div class="ledger-sheet">
    <div class="ledger-type-switch" role="group" :aria-label="t('notice.source')">
      <button type="button" :aria-pressed="mode === 'text'" :disabled="locked || choosing || pending" @click="changeMode('text')">{{ t('notice.textTab') }}</button>
      <button type="button" :aria-pressed="mode === 'image'" :disabled="locked || choosing || pending" @click="changeMode('image')">{{ t('notice.imageTab') }}</button>
    </div>
    <label v-if="mode === 'text'" class="ledger-field">
      {{ t('notice.textLabel') }}
      <textarea v-model="message" :disabled="locked || pending" rows="5" maxlength="4000" :placeholder="t('notice.example')" />
    </label>
    <template v-else>
      <img v-if="image" :key="image.imageToken" class="notice-preview" :src="image.previewUrl" :alt="t('notice.preview')"
        @load="previewState = 'ready'" @error="previewState = 'failed'" />
      <p v-if="image && previewState === 'failed'" class="ledger-error" role="alert">{{ t('billImage.previewError') }}</p>
      <div class="ledger-inline-actions">
        <button v-if="image" class="ledger-text-btn" type="button" :disabled="locked || choosing || pending" @click="discardImage">{{ t('notice.removeImage') }}</button>
        <button class="ledger-secondary" type="button" :disabled="locked || choosing || pending" @click="choose">
          <ImagePlus :size="16" aria-hidden="true" />{{ t(image ? 'billImage.change' : 'notice.chooseImage') }}
        </button>
      </div>
    </template>
    <p class="ledger-hint">{{ t(mode === 'text' ? 'notice.consentText' : 'notice.consentImage', { month: formatMonth(referenceMonth) }) }}</p>
    <p v-if="pickerError" class="ledger-error" role="alert">{{ pickerError }}</p>
    <p v-if="error" class="ledger-error" role="alert">{{ error }} <RouterLink :to="{ name: 'settings-ai' }">{{ t('billImage.settings') }}</RouterLink></p>
    <p v-if="pending" role="status">{{ t('notice.pending') }}</p>
    <div class="ledger-form-actions">
      <button v-if="pending" type="button" class="ledger-secondary" @click="cancel">{{ t('forms.cancel') }}</button>
      <button v-else type="button" class="ledger-secondary" :disabled="locked || choosing" @click="manual">{{ t('notice.manual') }}</button>
      <button type="button" class="ledger-primary" :disabled="locked || choosing || pending || !hasSource" @click="send">{{ t('notice.send') }}</button>
    </div>
  </div>
</template>

<style scoped>
textarea { box-sizing: border-box; width: 100%; min-height: 110px; padding: 12px; resize: vertical; font: inherit; font-weight: 400; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 8px; }
textarea:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.notice-preview { width: 100%; max-height: 48vh; object-fit: contain; background: var(--soft); border-radius: 8px; }
</style>
