<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ImagePlus } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { BillInput } from '../../domain/ledger'
import { displayError, formatMoney, t } from '../../i18n'
import { chooseAiImage, recognizeAiBills, releaseAiImage } from '../../integrations/ai/deepseek'
import { estimateAmountsConflict, type RecognizedBillDraft } from '../../integrations/ai/visionDrafts'
import BillForm from '../bills/components/BillForm.vue'
import { useAssistantRequest } from './useAssistantRequest'

interface ReviewRow {
  draft: RecognizedBillDraft
  status: 'pending' | 'skipped' | 'saved'
}

const emit = defineEmits<{ 'active-change': [active: boolean] }>()
const { data, month, busy, needsReload, repository, commit } = useLedgerSession()
const { pending, error, run, cancel } = useAssistantRequest()
const choosing = ref(false)
const preview = ref('')
const imageState = ref<'loading' | 'ready' | 'error'>('loading')
const pickerError = ref('')
const rows = ref<ReviewRow[] | null>(null)
const editing = ref<number | null>(null)
const current = computed(() => editing.value === null ? null : rows.value?.[editing.value])
const saved = computed(() => rows.value?.filter(row => row.status === 'saved').length ?? 0)
const writing = computed(() => busy.value || needsReload.value)
let token = ''
let mounted = true

function release() {
  if (token) void releaseAiImage(token).catch(() => {})
  token = ''
}

function close() {
  cancel()
  release()
  preview.value = ''
  pickerError.value = ''
  editing.value = null
  rows.value = null
  emit('active-change', false)
}

async function choose() {
  if (choosing.value || pending.value || writing.value) return
  choosing.value = true
  pickerError.value = ''
  try {
    const file = await chooseAiImage()
    if (!file) return
    if (!mounted) {
      void releaseAiImage(file.imageToken).catch(() => {})
      return
    }
    release()
    token = file.imageToken
    imageState.value = 'loading'
    preview.value = file.previewUrl
    editing.value = null
    rows.value = null
    error.value = ''
    emit('active-change', true)
  } catch (cause) {
    if (mounted) pickerError.value = displayError(cause)
  } finally {
    choosing.value = false
  }
}

function recognize() {
  if (!token || imageState.value !== 'ready' || choosing.value || pending.value || rows.value) return
  void run(signal => recognizeAiBills(token, signal), drafts => {
    release()
    rows.value = drafts.map(draft => ({ draft, status: 'pending' }))
    editing.value = drafts.length === 1 ? 0 : null
  })
}

function save(input: BillInput) {
  const row = current.value
  if (!row || row.status === 'saved' || writing.value) return
  return commit(() => repository.createBill(input), () => {
    row.status = 'saved'
    row.draft.title = input.title
    editing.value = null
  })
}

function skip() {
  if (current.value && !writing.value) {
    current.value.status = 'skipped'
    editing.value = null
  }
}

onBeforeUnmount(() => {
  mounted = false
  release()
  emit('active-change', false)
})
</script>

<template>
  <section class="ledger-editor image-import" :aria-label="t('billImage.open')">
    <template v-if="!preview">
      <button type="button" class="ledger-secondary image-open" :disabled="choosing || writing" @click="choose">
        <ImagePlus :size="17" aria-hidden="true" />{{ t('billImage.open') }}
      </button>
    </template>
    <template v-else-if="rows === null">
      <h1>{{ t('billImage.open') }}</h1>
      <div class="ledger-sheet">
        <img :key="token" :src="preview" class="image-preview" :alt="t('billImage.preview')" @load="imageState = 'ready'" @error="imageState = 'error'" />
        <p v-if="imageState === 'error'" class="ledger-error" role="alert">{{ t('billImage.previewError') }}</p>
        <p>{{ t('billImage.consent') }}</p>
        <p v-if="pending" role="status">{{ t('billImage.pending') }}</p>
        <p v-if="error" class="ledger-error" role="alert">{{ error }} <RouterLink :to="{ name: 'settings-ai' }">{{ t('billImage.settings') }}</RouterLink></p>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary" :disabled="choosing" @click="close">{{ t('forms.cancel') }}</button>
          <button type="button" class="ledger-secondary" :disabled="choosing || pending" @click="choose">{{ t('billImage.change') }}</button>
          <button type="button" class="ledger-primary" :disabled="imageState !== 'ready' || choosing || pending" @click="recognize">{{ t('billImage.send') }}</button>
        </div>
      </div>
    </template>
    <template v-else>
      <h1>{{ t('billImage.review') }}</h1>
      <details class="source-image">
        <summary>{{ t('billImage.source') }}</summary>
        <img :src="preview" class="image-preview" :alt="t('billImage.preview')" />
      </details>
      <template v-if="current && editing !== null && data">
        <h2>{{ t('billImage.item', { index: editing + 1, count: rows.length }) }}</h2>
        <p v-if="current.draft.platformHint" class="ledger-hint">{{ t('billImage.platformHint', { platform: current.draft.platformHint }) }}</p>
        <p v-if="current.draft.kind === 'estimate' && current.draft.amountCents !== null" class="ledger-hint">
          {{ t('billImage.recognizedBalance', { amount: formatMoney(current.draft.amountCents) }) }}
        </p>
        <p v-if="estimateAmountsConflict(current.draft)" class="ledger-error" role="status">{{ t('billImage.amountConflict') }}</p>
        <BillForm :key="editing" :platforms="data.platforms" :initial-draft="current.draft" :month="month"
          :busy="writing" :entry="null" review @cancel="skip" @submit="save" />
      </template>
      <div v-else class="ledger-sheet">
        <p role="status">{{ rows.length ? t('billImage.progress', { count: rows.length, saved }) : t('billImage.empty') }}</p>
        <ul v-if="rows.length" class="draft-list">
          <li v-for="(row, index) in rows" :key="index">
            <div><strong>{{ row.draft.title || t('billImage.untitled') }}</strong>
              <small v-if="row.status === 'skipped'">{{ t('billImage.skipped') }}</small></div>
            <span v-if="row.status === 'saved'">{{ t('billImage.saved') }}</span>
            <button v-else type="button" class="ledger-secondary" :disabled="writing" @click="editing = index">{{ t('billImage.edit') }}</button>
          </li>
        </ul>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary" :disabled="writing" @click="close">{{ t('billImage.finish') }}</button>
        </div>
      </div>
    </template>
    <p v-if="pickerError" class="ledger-error" role="alert">{{ pickerError }}</p>
  </section>
</template>

<style scoped>
.image-import { margin-bottom: 16px; }
.image-open { justify-self: end; }
.image-preview { display: block; width: 100%; max-height: 52vh; object-fit: contain; border-radius: 8px; background: var(--soft); }
.source-image { min-width: 0; }
.source-image summary { width: fit-content; min-height: 36px; color: var(--green); cursor: pointer; }
.draft-list { list-style: none; padding: 0; }
.draft-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 10px; border-bottom: 1px solid var(--line); }
.draft-list li div { min-width: 0; overflow-wrap: anywhere; }
.draft-list small { display: block; color: var(--sub); }
.draft-list button { flex: none; }
</style>
