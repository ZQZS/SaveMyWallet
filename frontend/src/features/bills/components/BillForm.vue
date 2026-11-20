<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeft, CalendarDays } from 'lucide-vue-next'
import { t, formatMoney, formatMonth } from '../../../i18n'
import { isMonth, MAX_MONTH, MIN_MONTH, shiftMonth, toCents } from '../../../domain/ledger'
import type { BillInput, Entry, Platform } from '../../../domain/ledger'
import PlatformPicker from '../../platforms/components/PlatformPicker.vue'

const props = defineProps<{ platforms: Platform[]; month: string; entry: Entry | null; busy: boolean }>()
const emit = defineEmits<{
  submit: [input: BillInput]
  cancel: []
}>()

const kinds = ['single', 'installment', 'estimate'] as const
const kind = ref<BillInput['kind']>('single')
const platformId = ref('')
const title = ref('')
const amount = ref('')
const month = ref('')
const count = ref('3')
const errorKey = ref('')
const creatingPlatform = ref(false)
const amountCents = computed(() => toCents(amount.value))
const isInstallment = computed(() => kind.value === 'installment' && !props.entry)
const lastMonth = computed(() => {
  const periods = Number(count.value)
  if (!isMonth(month.value) || !Number.isInteger(periods) || periods < 1 || periods > 120) return ''
  const end = shiftMonth(month.value, periods - 1)
  return isMonth(end) ? end : ''
})

watch([() => props.entry?.id, () => props.month], () => {
  const entry = props.entry
  kind.value = entry?.kind ?? 'single'
  platformId.value = entry?.platformId ?? props.platforms[0]?.id ?? ''
  title.value = entry?.title ?? ''
  amount.value = entry ? String(entry.amountCents / 100) : ''
  month.value = entry?.month ?? props.month
  count.value = '3'
  errorKey.value = ''
  creatingPlatform.value = false
}, { immediate: true })

watch(() => props.platforms, platforms => {
  if (!platforms.some(platform => platform.id === platformId.value)) platformId.value = platforms[0]?.id ?? ''
})

function submit() {
  if (props.busy || creatingPlatform.value) return
  errorKey.value = ''
  const trimmedTitle = title.value.trim()
  const cents = amountCents.value
  if (!props.platforms.some(platform => platform.id === platformId.value)) {
    errorKey.value = 'forms.selectPlatformError'
  } else if (!trimmedTitle || Array.from(trimmedTitle).length > 120) {
    errorKey.value = 'forms.titleError'
  } else if (cents === null || cents < 1) {
    errorKey.value = 'forms.amountError'
  } else if (!isMonth(month.value)) {
    errorKey.value = 'forms.monthError'
  } else if (isInstallment.value && !lastMonth.value) {
    errorKey.value = 'forms.scheduleError'
  } else {
    emit('submit', { platformId: platformId.value, title: trimmedTitle, month: month.value, amountCents: cents,
      kind: kind.value, installmentCount: isInstallment.value ? Number(count.value) : 1 })
  }
}
</script>

<template>
  <section class="ledger-editor" aria-labelledby="bill-heading">
    <header class="ledger-form-head">
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
        <label class="ledger-field">
          <span>{{ t(entry ? 'forms.amountConfirmed' : isInstallment ? 'forms.amountPerPeriod' : kind === 'estimate' ? 'forms.amountEstimated' : 'forms.amountDue') }}</span>
          <input v-model="amount" name="amount" inputmode="decimal" required :disabled="busy" placeholder="0.00" />
        </label>
        <label class="ledger-field">
          <span>{{ t(entry ? 'forms.monthConfirmed' : isInstallment ? 'forms.monthFirst' : kind === 'estimate' ? 'forms.monthEstimated' : 'forms.monthDue') }}</span>
          <input v-model="month" name="month" type="month" :min="MIN_MONTH" :max="MAX_MONTH" required :disabled="busy" />
        </label>
        <label v-if="isInstallment" class="ledger-field"><span>{{ t('forms.periodCount') }}</span>
          <input v-model="count" name="count" type="number" inputmode="numeric" min="1" max="120" step="1" required :disabled="busy" />
        </label>
      </div>
      <div v-if="isInstallment" class="ledger-summary">
        <CalendarDays :size="18" aria-hidden="true" />
        <div><strong>{{ t('forms.schedule') }}</strong>
          <p v-if="lastMonth && amountCents !== null && amountCents > 0">
            {{ t('forms.schedulePreview', { start: formatMonth(month), end: formatMonth(lastMonth), count, total: formatMoney(amountCents * Number(count)) }) }}
          </p>
          <p v-else>{{ t('forms.scheduleHint') }}</p>
        </div>
      </div>
      <p v-else-if="entry" class="ledger-hint">{{ t('forms.confirmHint') }}</p>
      <p v-else-if="kind === 'estimate'" class="ledger-hint">{{ t('forms.estimatedHelp') }}</p>
      <p v-else class="ledger-hint">{{ t('forms.singleHelp') }}</p>
      <p v-if="errorKey" class="ledger-error" role="alert">{{ t(errorKey) }}</p>
      <div class="ledger-form-actions">
        <button type="button" class="ledger-secondary" :disabled="busy" @click="emit('cancel')">{{ t('forms.cancel') }}</button>
        <button type="submit" class="ledger-primary" :disabled="busy || creatingPlatform">{{ t(entry ? 'forms.confirmDue' : 'forms.saveBill') }}</button>
      </div>
    </form>
  </section>
</template>
