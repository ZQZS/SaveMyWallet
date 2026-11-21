<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ImagePlus } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import type { BillInput } from '../../domain/ledger'
import { displayError, formatMoney, formatMonth, t } from '../../i18n'
import { chooseAiImage, recognizeAiBills, releaseAiImage } from '../../integrations/ai/deepseek'
import { draftPlatformId, estimateAmountsConflict, type RecognizedBillDraft } from '../../integrations/ai/visionDrafts'
import BillForm from '../bills/components/BillForm.vue'
import { readInstallmentSchedule } from '../bills/installmentSchedule'
import PlatformPicker from '../platforms/components/PlatformPicker.vue'
import BillScreenshotPreview from './BillScreenshotPreview.vue'
import { prepareScreenshotBatch, screenshotAmountCents, screenshotPlatformId, type ScreenshotReviewRow, type ScreenshotStatement } from './billImageReview'
import { useAssistantRequest } from './useAssistantRequest'

const emit = defineEmits<{ 'active-change': [active: boolean] }>()
const { data, month, busy, needsReload, repository, commit } = useLedgerSession()
const { pending, error, run, cancel } = useAssistantRequest()
const choosing = ref(false)
const preview = ref('')
const selectedPlatformId = ref('')
const creatingPlatform = ref(false)
const imageState = ref<'loading' | 'ready' | 'error'>('loading')
const pickerError = ref('')
const rows = ref<ScreenshotReviewRow[] | null>(null)
const statement = ref<ScreenshotStatement | null>(null)
const editing = ref<number | null>(null)
const reviewHeading = ref<HTMLElement | null>(null)
const draftPanel = ref<HTMLElement | null>(null)
const current = computed(() => editing.value === null ? null : rows.value?.[editing.value])
const saved = computed(() => rows.value?.filter(row => row.status === 'saved').length ?? 0)
const selectedPlatform = computed(() => data.value?.platforms.find(platform => platform.id === selectedPlatformId.value))
const batch = computed(() => prepareScreenshotBatch(rows.value ?? [], selectedPlatform.value?.id ?? '', statement.value))
const hasPendingInstallments = computed(() => rows.value?.some(row => row.status === 'pending' && row.draft.kind === 'installment'))
const writing = computed(() => busy.value || needsReload.value)
const batchOperationIds = new Map<string, string>()
let token = ''
let mounted = true

watch(() => data.value?.platforms, platforms => {
  if (!platforms?.some(platform => platform.id === selectedPlatformId.value)) {
    selectedPlatformId.value = screenshotPlatformId(platforms ?? [], rows.value?.map(row => row.draft) ?? [])
  }
})

function release() {
  if (token) void releaseAiImage(token).catch(() => {})
  token = ''
}

function close() {
  cancel()
  release()
  batchOperationIds.clear()
  preview.value = ''
  selectedPlatformId.value = ''
  creatingPlatform.value = false
  pickerError.value = ''
  editing.value = null
  rows.value = null
  statement.value = null
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
    batchOperationIds.clear()
    creatingPlatform.value = false
    token = file.imageToken
    imageState.value = 'loading'
    preview.value = file.previewUrl
    editing.value = null
    rows.value = null
    statement.value = null
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
  void run(signal => recognizeAiBills(token, signal, platform?.name, month.value), ({ drafts, statementTotalCents, isMonthlyStatement }) => {
    release()
    statement.value = isMonthlyStatement ? { totalCents: statementTotalCents } : null
    selectedPlatformId.value = screenshotPlatformId(data.value?.platforms ?? [], drafts, selectedPlatformId.value)
    rows.value = drafts.map(draft => ({ draft, status: 'pending' }))
    if (drafts.length === 1) edit(0)
  })
}

function installmentLabel(draft: RecognizedBillDraft) {
  if (draft.kind !== 'installment' || !draft.month || !draft.installmentCount || draft.installmentIndex === null) return ''
  const index = draft.installmentIndex ?? 1
  const schedule = readInstallmentSchedule(draft.month, draft.installmentCount, index)
  if (!schedule) return ''
  return t('billImage.installmentRange', { index, count: draft.installmentCount, end: formatMonth(schedule.lastMonth) })
}

function amountLabel(draft: RecognizedBillDraft) {
  const cents = screenshotAmountCents(draft)
  return cents === null ? t('billImage.checkAmount') : formatMoney(cents)
}

function showPlatformHint(draft: RecognizedBillDraft) {
  return draft.platformHint && (!selectedPlatform.value || draftPlatformId(data.value?.platforms ?? [], draft.platformHint) !== selectedPlatform.value.id)
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

function markSaved(row: ScreenshotReviewRow, input: BillInput) {
  row.status = 'saved'
  row.draft = { platformHint: row.draft.platformHint, refundText: row.draft.refundText, title: input.title, kind: input.kind, month: input.month,
    amountCents: input.amountCents, depositCents: input.depositCents, totalCents: input.totalCents,
    installmentCount: input.kind === 'installment' ? input.installmentCount : null, installmentIndex: input.installmentIndex }
}

function save(input: BillInput) {
  const row = current.value
  if (!row || row.status === 'saved' || writing.value) return
  return commit(() => repository.createBill(input), () => {
    markSaved(row, input)
    returnToList()
  })
}

function saveAll() {
  const { inputs } = batch.value
  if (!inputs.length || creatingPlatform.value || writing.value) return
  const pendingRows = (rows.value ?? []).filter(row => row.status === 'pending')
  const signature = JSON.stringify(inputs)
  const operationId = batchOperationIds.get(signature) ?? crypto.randomUUID()
  batchOperationIds.set(signature, operationId)
  return commit(() => repository.createBills(inputs, operationId), () => {
    pendingRows.forEach((row, index) => markSaved(row, inputs[index]))
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
      <section v-if="statement" class="ledger-summary statement-review" :class="{ 'ledger-summary-warning': batch.differenceCents !== 0 }"
        :aria-label="t('billImage.statementReview')" aria-live="polite">
        <div>
          <h2>{{ t('billImage.statementReview') }}</h2>
          <p>{{ statement.totalCents === null ? t('billImage.missingStatementTotal')
            : t('billImage.statementTotal', { amount: formatMoney(statement.totalCents) }) }}</p>
          <p v-if="batch.details.totalCents !== null">{{ t('billImage.statementDetails', { amount: formatMoney(batch.details.totalCents) }) }}</p>
          <p v-else-if="batch.details.issue">{{ t(batch.details.issue) }}</p>
          <p v-if="batch.differenceCents !== null"><strong>{{ batch.differenceCents === 0 ? t('billImage.totalsMatch')
            : t(batch.differenceCents < 0 ? 'billImage.detailsShort' : 'billImage.detailsOver', { amount: formatMoney(Math.abs(batch.differenceCents)) }) }}</strong></p>
          <p v-if="batch.differenceCents !== 0 && rows.length">{{ t('billImage.manualReview') }}</p>
        </div>
      </section>
      <template v-if="current && editing !== null && data">
        <h2 ref="reviewHeading" tabindex="-1">{{ t('billImage.item', { index: editing + 1, count: rows.length }) }}</h2>
        <p v-if="current.draft.platformHint" class="ledger-hint">{{ t('billImage.platformHint', { platform: current.draft.platformHint }) }}</p>
        <p v-if="current.draft.refundText" class="ledger-hint">{{ t('billImage.refundNote', { text: current.draft.refundText }) }}</p>
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
          <strong v-if="!statement && rows.length > 1 && rows.length !== batch.pendingCount && batch.details.totalCents !== null">
            {{ t('billImage.detailTotal', { amount: formatMoney(batch.details.totalCents) }) }}
          </strong>
        </div>
        <section v-if="batch.pendingCount && data" class="batch-review" :aria-label="t('billImage.batchReview')">
          <h2>{{ t('billImage.batchReview') }}</h2>
          <PlatformPicker v-model="selectedPlatformId" v-model:editing="creatingPlatform" :platforms="data.platforms"
            :busy="writing" :locked="false" />
          <div class="batch-summary" aria-live="polite">
            <p>{{ selectedPlatform
              ? t('billImage.batchDestination', { count: batch.pendingCount, platform: selectedPlatform.name })
              : t('billImage.batchChoosePlatform', { count: batch.pendingCount }) }}</p>
            <p v-for="[period, cents] in batch.currentPeriods" :key="period">
              <strong>{{ t('billImage.currentPeriodTotal', { month: formatMonth(period), amount: formatMoney(cents) }) }}</strong>
            </p>
            <p v-if="hasPendingInstallments" class="ledger-hint">{{ t('billImage.remainingPeriods') }}</p>
            <p v-if="batch.issues.size" class="ledger-error">{{ t('billImage.needsReview', { count: batch.issues.size }) }}</p>
          </div>
          <button type="button" class="ledger-primary" :disabled="writing || creatingPlatform || !batch.inputs.length" @click="saveAll">
            {{ t('billImage.confirmAll') }}
          </button>
        </section>
        <ul v-if="rows.length" class="draft-list">
          <li v-for="(row, index) in rows" :key="index">
            <div>
              <strong>{{ row.draft.title || t('billImage.untitled') }}</strong>
              <small class="draft-facts">
                <span v-if="row.status === 'pending' && showPlatformHint(row.draft)">{{ row.draft.platformHint }}</span>
                <time v-if="row.draft.month" :datetime="row.draft.month">{{ formatMonth(row.draft.month) }}</time>
                <span>{{ amountLabel(row.draft) }}</span>
                <span v-if="row.draft.kind === 'installment'">{{ installmentLabel(row.draft) }}</span>
              </small>
              <small v-if="row.draft.refundText">{{ t('billImage.refundNote', { text: row.draft.refundText }) }}</small>
              <small v-if="batch.issues.has(index)" class="draft-issue">{{ t(batch.issues.get(index)!) }}</small>
              <small v-if="row.status === 'skipped'">{{ t('billImage.skipped') }}</small>
            </div>
            <span v-if="row.status === 'saved'">{{ t('billImage.saved') }}</span>
            <button v-else type="button" class="ledger-secondary" :data-draft-index="index" :disabled="writing || creatingPlatform" @click="edit(index)">{{ t('billImage.edit') }}</button>
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
.statement-review { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.batch-review { min-width: 0; display: grid; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.batch-review > button { justify-self: start; }
.batch-summary { display: grid; gap: 4px; overflow-wrap: anywhere; }
.batch-summary strong { font-variant-numeric: tabular-nums; }
.draft-list { list-style: none; padding: 0; }
.draft-list li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 10px; border-bottom: 1px solid var(--line); }
.draft-list li div { min-width: 0; overflow-wrap: anywhere; }
.draft-list small { display: block; color: var(--sub); }
.draft-list .draft-issue { color: #a03123; }
.draft-list .draft-facts { display: flex; flex-wrap: wrap; gap: 2px 10px; font-variant-numeric: tabular-nums; }
.draft-list button { flex: none; }
</style>
