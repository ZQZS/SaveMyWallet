<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, CalendarDays } from 'lucide-vue-next'
import { t, formatMoney, formatMonth } from '../../../i18n'
import { estimateTotalCents, isMonth, MAX_MONTH, MIN_MONTH } from '../../../domain/ledger'
import type { BillInput, Entry, Platform } from '../../../domain/ledger'
import { draftPlatformId, type RecognizedBillDraft } from '../../../integrations/ai/visionDrafts'
import PlatformPicker from '../../platforms/components/PlatformPicker.vue'
import { readBillAmounts } from '../billAmounts'
import { readInstallmentSchedule } from '../installmentSchedule'

const props = defineProps<{
  platforms: Platform[]; month: string; entry: Entry | null; busy: boolean
  initialDraft?: Partial<RecognizedBillDraft>; initialPlatformId?: string; review?: boolean
}>()
const emit = defineEmits<{
  submit: [input: BillInput]
  cancel: []
}>()

const kinds = ['single', 'installment', 'estimate'] as const
const kind = ref<BillInput['kind'] | ''>('single')
const platformId = ref('')
const title = ref('')
const amount = ref('')
const totalPrice = ref('')
const deposit = ref('0')
const month = ref('')
const count = ref('3')
const installmentIndex = ref('1')
const errorKey = ref('')
const creatingPlatform = ref(false)
const isEstimate = computed(() => kind.value === 'estimate')
const amounts = computed(() => readBillAmounts(kind.value, amount.value, totalPrice.value, deposit.value))
const amountCents = computed(() => typeof amounts.value === 'string' ? null : amounts.value.amountCents)
const isInstallment = computed(() => kind.value === 'installment' && !props.entry)
const reviewInstallment = computed(() => props.review && isInstallment.value)
const schedule = computed(() => readInstallmentSchedule(month.value, Number(count.value),
  reviewInstallment.value ? Number(installmentIndex.value) : 1))

watch([() => props.entry?.id, () => props.month, () => props.initialDraft], () => {
  const entry = props.entry
  const draft = props.initialDraft
  kind.value = entry?.kind ?? (draft ? draft.kind ?? '' : 'single')
  platformId.value = entry?.platformId ?? (draft
    ? draftPlatformId(props.platforms, draft.platformHint, props.initialPlatformId)
    : props.platforms[0]?.id ?? '')
  title.value = entry?.title ?? draft?.title ?? ''
  const cents = entry?.amountCents ?? draft?.amountCents
  amount.value = cents == null ? '' : String(cents / 100)
  const total = entry?.kind === 'estimate' ? estimateTotalCents(entry) : draft?.totalCents
  totalPrice.value = total == null ? '' : String(total / 100)
  deposit.value = String((entry?.depositCents ?? draft?.depositCents ?? 0) / 100)
  month.value = entry?.month ?? (draft ? draft.month ?? '' : props.month)
  count.value = draft ? String(draft.installmentCount ?? '') : '3'
  installmentIndex.value = draft?.installmentIndex === null ? '' : String(draft?.installmentIndex ?? 1)
  errorKey.value = ''
  creatingPlatform.value = false
}, { immediate: true })

watch(() => props.platforms, platforms => {
  if (!platforms.some(platform => platform.id === platformId.value)) {
    platformId.value = props.initialDraft ? '' : platforms[0]?.id ?? ''
  }
})

function submit() {
  if (props.busy || creatingPlatform.value) return
  errorKey.value = ''
  const trimmedTitle = title.value.trim()
  const validatedAmounts = amounts.value
  if (!kind.value) {
    errorKey.value = 'billImage.selectKind'
  } else if (!props.platforms.some(platform => platform.id === platformId.value)) {
    errorKey.value = 'forms.selectPlatformError'
  } else if (!trimmedTitle || Array.from(trimmedTitle).length > 120) {
    errorKey.value = 'forms.titleError'
  } else if (typeof validatedAmounts === 'string') {
    errorKey.value = validatedAmounts
  } else if (!isMonth(month.value)) {
    errorKey.value = 'forms.monthError'
  } else if (isInstallment.value && !schedule.value) {
    errorKey.value = reviewInstallment.value ? 'forms.reviewScheduleError' : 'forms.scheduleError'
  } else {
    emit('submit', { platformId: platformId.value, title: trimmedTitle, month: month.value, ...validatedAmounts,
      kind: kind.value, installmentCount: isInstallment.value ? Number(count.value) : 1,
      ...(reviewInstallment.value ? { installmentIndex: Number(installmentIndex.value) } : {}) })
  }
}
</script>

<template>
  <section class="ledger-editor" :aria-labelledby="review ? undefined : 'bill-heading'" :aria-label="review ? t('billImage.review') : undefined">
    <header v-if="!review" class="ledger-form-head">
      <button type="button" class="ledger-back" :aria-label="t('forms.back')" :disabled="busy" @click="emit('cancel')"><ArrowLeft :size="20" /></button>
      <h1 id="bill-heading">{{ t(entry ? 'forms.confirmBill' : 'forms.newBill') }}</h1>
    </header>
    <form class="ledger-sheet" novalidate @submit.prevent="submit">
      <div v-if="!entry" class="ledger-type-switch" role="group" :aria-label="t('forms.typeLabel')">
        <button v-for="option in kinds" :key="option" type="button" :aria-pressed="kind === option" :disabled="busy"
          @click="kind = option; errorKey = ''">{{ t('forms.' + option) }}</button>
      </div>
      <div class="ledger-fields">
        <PlatformPicker v-model="platformId" v-model:editing="creatingPlatform" :platforms="platforms"
          :busy="busy" :locked="Boolean(entry)" />
        <label class="ledger-field"><span>{{ t('forms.title') }}</span>
          <input v-model="title" name="title" :disabled="busy" required :placeholder="t(kind === 'estimate' ? 'forms.estimateHint' : 'forms.titleHint')" />
        </label>
        <template v-if="isEstimate">
          <label class="ledger-field"><span>{{ t('forms.estimateTotal') }}</span>
            <input v-model="totalPrice" name="totalPrice" inputmode="decimal" required :disabled="busy" placeholder="0.00" />
          </label>
          <label class="ledger-field"><span>{{ t('forms.paidDeposit') }}</span>
            <input v-model="deposit" name="deposit" inputmode="decimal" :disabled="busy" placeholder="0" />
          </label>
        </template>
        <label v-else class="ledger-field">
          <span>{{ t(isInstallment ? 'forms.amountPerPeriod' : 'forms.amountDue') }}</span>
          <input v-model="amount" name="amount" inputmode="decimal" required :disabled="busy" placeholder="0.00" />
        </label>
        <label class="ledger-field">
          <span>{{ t(entry ? 'forms.monthConfirmed' : reviewInstallment ? 'forms.monthCurrent' : isInstallment ? 'forms.monthFirst' : kind === 'estimate' ? 'forms.monthEstimated' : 'forms.monthDue') }}</span>
          <input v-model="month" name="month" type="month" :min="MIN_MONTH" :max="MAX_MONTH" required :disabled="busy" />
        </label>
        <label v-if="reviewInstallment" class="ledger-field"><span>{{ t('forms.currentPeriod') }}</span>
          <input v-model="installmentIndex" name="installmentIndex" type="number" inputmode="numeric" min="1" :max="count || 120" step="1" required :disabled="busy" />
        </label>
        <label v-if="isInstallment" class="ledger-field"><span>{{ t(reviewInstallment ? 'forms.totalPeriods' : 'forms.periodCount') }}</span>
          <input v-model="count" name="count" type="number" inputmode="numeric" min="1" max="120" step="1" required :disabled="busy" />
        </label>
      </div>
      <div v-if="isInstallment" class="ledger-summary">
        <CalendarDays :size="18" aria-hidden="true" />
        <div><strong>{{ t('forms.schedule') }}</strong>
          <p v-if="schedule && amountCents !== null && amountCents > 0">
            {{ t(reviewInstallment ? 'forms.reviewSchedulePreview' : 'forms.schedulePreview', {
              start: formatMonth(month), end: formatMonth(schedule.lastMonth), count: schedule.remaining, total: formatMoney(amountCents * schedule.remaining),
            }) }}
          </p>
          <p v-else>{{ t(reviewInstallment ? 'forms.reviewScheduleHint' : 'forms.scheduleHint') }}</p>
        </div>
      </div>
      <div v-else-if="isEstimate" class="ledger-summary">
        <div><strong>{{ t('ledger.balancePayment') }} <output aria-live="polite">{{ amountCents === null ? '—' : formatMoney(amountCents) }}</output></strong>
          <p>{{ t(entry ? 'forms.confirmHint' : 'forms.estimatedHelp') }}</p>
        </div>
      </div>
      <p v-else-if="kind === 'single'" class="ledger-hint">{{ t('forms.singleHelp') }}</p>
      <p v-if="errorKey" class="ledger-error" role="alert">{{ t(errorKey) }}</p>
      <div class="ledger-form-actions">
        <button type="button" class="ledger-secondary" :disabled="busy" @click="emit('cancel')">{{ t(review ? 'billImage.skip' : 'forms.cancel') }}</button>
        <button type="submit" class="ledger-primary" :disabled="busy || creatingPlatform">{{ t(review ? 'billImage.confirm' : entry ? 'forms.confirmBill' : 'forms.saveBill') }}</button>
      </div>
    </form>
  </section>
</template>
