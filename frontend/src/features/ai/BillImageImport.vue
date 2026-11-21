<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ImagePlus } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { BillInput } from '../../domain/ledger'
import { displayError, formatMoney, formatMonth, t } from '../../i18n'
import { chooseAiImage, recognizeAiBills, releaseAiImage } from '../../integrations/ai/deepseek'
import { estimateAmountsConflict, type RecognizedBillDraft } from '../../integrations/ai/visionDrafts'
import BillForm from '../bills/components/BillForm.vue'
import BillScreenshotPreview from './BillScreenshotPreview.vue'
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
const selectedPlatformId = ref('')
const imageState = ref<'loading' | 'ready' | 'error'>('loading')
const pickerError = ref('')
const rows = ref<ReviewRow[] | null>(null)
const editing = ref<number | null>(null)
const reviewHeading = ref<HTMLElement | null>(null)
const draftPanel = ref<HTMLElement | null>(null)
const current = computed(() => editing.value === null ? null : rows.value?.[editing.value])
const saved = computed(() => rows.value?.filter(row => row.status === 'saved').length ?? 0)
const detailTotal = computed(() => {
  const items = rows.value
  const statementMonth = items?.[0]?.draft.month
  if (!items || items.length < 2 || !statementMonth) return null
  let cents = 0
  for (const { draft } of items) {
    if (draft.kind !== 'single' || draft.month !== statementMonth || draft.amountCents === null) return null
    cents += draft.amountCents
  }
  return Number.isSafeInteger(cents) ? cents : null
})
const writing = computed(() => busy.value || needsReload.value)
let token = ''
let mounted = true

watch(() => data.value?.platforms, platforms => {
  if (!platforms?.some(platform => platform.id === selectedPlatformId.value)) selectedPlatformId.value = ''
})

function release() {
  if (token) void releaseAiImage(token).catch(() => {})
  token = ''
}

function close() {
  cancel()
  release()
  preview.value = ''
  selectedPlatformId.value = ''
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
  const platform = data.value?.platforms.find(platform => platform.id === selectedPlatformId.value)
  void run(signal => recognizeAiBills(token, signal, platform?.name, month.value), drafts => {
    release()
    rows.value = drafts.map(draft => ({ draft, status: 'pending' }))
    if (drafts.length === 1) edit(0)
  })
}

function edit(index: number) {
  editing.value = index
  nextTick(() => reviewHeading.value?.focus())
}

function returnToList() {
  const previous = editing.value ?? -1
  const drafts = rows.value ?? []
  let next = drafts.findIndex((row, index) => index > previous && row.status === 'pending')
  if (next === -1) next = drafts.findIndex(row => row.status === 'pending')
  editing.value = null
  nextTick(() => {
    const selector = next === -1 ? '.finish-review' : `[data-draft-index="${next}"]`
    draftPanel.value?.querySelector<HTMLButtonElement>(selector)?.focus()
  })
}

function save(input: BillInput) {
  const row = current.value
  if (!row || row.status === 'saved' || writing.value) return
  return commit(() => repository.createBill(input), () => {
    row.status = 'saved'
    row.draft.title = input.title
    row.draft.kind = input.kind
    row.draft.month = input.month
    row.draft.amountCents = input.amountCents
    returnToList()
  })
}

function skip() {
  if (current.value && !writing.value) {
    current.value.status = 'skipped'
    returnToList()
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
        <BillScreenshotPreview :key="token" :src="preview" @load="imageState = 'ready'" @error="imageState = 'error'" />
        <p v-if="imageState === 'error'" class="ledger-error" role="alert">{{ t('billImage.previewError') }}</p>
        <label v-if="data?.platforms.length" class="ledger-field">
          <span>{{ t('forms.platform') }}</span>
          <select v-model="selectedPlatformId" :disabled="choosing || pending">
            <option value="">{{ t('billImage.autoPlatform') }}</option>
            <option v-for="platform in data.platforms" :key="platform.id" :value="platform.id">{{ platform.name }}</option>
          </select>
        </label>
        <p>{{ t('billImage.consent', { month: formatMonth(month) }) }}</p>
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
        <BillScreenshotPreview :src="preview" />
      </details>
      <template v-if="current && editing !== null && data">
        <h2 ref="reviewHeading" tabindex="-1">{{ t('billImage.item', { index: editing + 1, count: rows.length }) }}</h2>
        <p v-if="current.draft.platformHint" class="ledger-hint">{{ t('billImage.platformHint', { platform: current.draft.platformHint }) }}</p>
        <p v-if="current.draft.kind === 'estimate' && current.draft.amountCents !== null" class="ledger-hint">
          {{ t('billImage.recognizedBalance', { amount: formatMoney(current.draft.amountCents) }) }}
        </p>
        <p v-if="estimateAmountsConflict(current.draft)" class="ledger-error" role="status">{{ t('billImage.amountConflict') }}</p>
        <BillForm :key="editing" :platforms="data.platforms" :initial-draft="current.draft" :initial-platform-id="selectedPlatformId" :month="month"
          :busy="writing" :entry="null" review @cancel="skip" @submit="save" />
      </template>
      <div v-else ref="draftPanel" class="ledger-sheet">
        <div class="draft-progress">
          <p role="status">{{ rows.length ? t('billImage.progress', { count: rows.length, saved }) : t('billImage.empty') }}</p>
          <strong v-if="detailTotal !== null">{{ t('billImage.detailTotal', { amount: formatMoney(detailTotal) }) }}</strong>
        </div>
        <ul v-if="rows.length" class="draft-list">
          <li v-for="(row, index) in rows" :key="index">
            <div>
              <strong>{{ row.draft.title || t('billImage.untitled') }}</strong>
              <small v-if="row.draft.month || row.draft.amountCents !== null" class="draft-facts">
                <time v-if="row.draft.month" :datetime="row.draft.month">{{ formatMonth(row.draft.month) }}</time>
                <span v-if="row.draft.amountCents !== null">{{ formatMoney(row.draft.amountCents) }}</span>
              </small>
              <small v-if="row.status === 'skipped'">{{ t('billImage.skipped') }}</small>
            </div>
            <span v-if="row.status === 'saved'">{{ t('billImage.saved') }}</span>
            <button v-else type="button" class="ledger-secondary" :data-draft-index="index" :disabled="writing" @click="edit(index)">{{ t('billImage.edit') }}</button>
          </li>
        </ul>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary finish-review" :disabled="writing" @click="close">{{ t('billImage.finish') }}</button>
        </div>
      </div>
    </template>
    <p v-if="pickerError" class="ledger-error" role="alert">{{ pickerError }}</p>
  </section>
</template>

<style scoped>
.image-import { margin-bottom: 16px; }
.image-open { justify-self: end; }
.source-image { min-width: 0; }
.source-image summary { width: fit-content; min-height: 36px; color: var(--green); cursor: pointer; }
.draft-progress { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.draft-progress strong { font-variant-numeric: tabular-nums; }
.draft-list { list-style: none; padding: 0; }
.draft-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 10px; border-bottom: 1px solid var(--line); }
.draft-list li div { min-width: 0; overflow-wrap: anywhere; }
.draft-list small { display: block; color: var(--sub); }
.draft-list .draft-facts { display: flex; flex-wrap: wrap; gap: 2px 10px; font-variant-numeric: tabular-nums; }
.draft-list button { flex: none; }
</style>
