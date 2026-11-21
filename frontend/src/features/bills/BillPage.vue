<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../i18n'
import { useRoute } from 'vue-router'
import { useLedgerSession } from '../../app/ledgerSession'
import { useReturnToLedger } from '../../app/navigation'
import type { BillInput } from '../../domain/ledger'
import BillForm from './components/BillForm.vue'
import BillImageImport from '../ai/BillImageImport.vue'
import { readInstallmentTerms } from '../ai/installmentScenario'
import '../../shared/styles/ledger-forms.css'

const route = useRoute()
const returnToLedger = useReturnToLedger()
const { data, month, calendarMonth, busy, repository, commit, selectMonth } = useLedgerSession()
const confirming = computed(() => route.name === 'bill-confirm')
const reviewingImage = ref(false)
const initialDraft = computed(() => {
  const { kind, month, amount, installmentCount } = route.query
  if (confirming.value || kind !== 'installment' || typeof month !== 'string'
      || typeof amount !== 'string' || typeof installmentCount !== 'string') return
  const result = readInstallmentTerms(month, amount, installmentCount)
  if ('terms' in result) return {
    kind, month, amountCents: result.terms.amountCents, installmentCount: result.terms.installmentCount,
  } as const
})
const estimate = computed(() => {
  if (!confirming.value) return null
  return data.value?.entries.find(entry => entry.id === route.params.id && !entry.voided && entry.status === 'estimated') ?? null
})

function save(input: BillInput) {
  const entry = estimate.value
  if (confirming.value && !entry) return
  return commit(
    () => entry
      ? repository.confirmEstimate({ id: entry.id, title: input.title, month: input.month, amountCents: input.amountCents,
        totalCents: input.totalCents, depositCents: input.depositCents })
      : repository.createBill(input),
    () => {
      const carried = !entry && input.kind === 'estimate' && input.month < calendarMonth.value
      selectMonth(carried ? calendarMonth.value : input.month)
      const message = entry ? t(input.amountCents === 0 ? 'forms.coveredEstimateConfirmed' : 'forms.estimateConfirmed')
        : input.kind === 'installment' ? t('forms.installmentsSaved', { count: input.installmentCount }) : t('forms.billSaved')
      void returnToLedger(message)
    },
  )
}
</script>

<template>
  <template v-if="data">
    <section v-if="confirming && !estimate" class="ledger-editor" aria-labelledby="missing-estimate">
      <h1 id="missing-estimate">{{ t('forms.confirmBill') }}</h1>
      <div class="ledger-sheet">
        <p role="status">{{ t('forms.staleEstimate') }}</p>
        <div class="ledger-form-actions">
          <button type="button" class="ledger-secondary" @click="returnToLedger()">{{ t('forms.back') }}</button>
        </div>
      </div>
    </section>
    <template v-else>
      <BillImageImport v-if="!confirming" @active-change="reviewingImage = $event" />
      <BillForm v-show="confirming || !reviewingImage" :platforms="data.platforms" :month="month" :entry="estimate"
        :busy="busy" :initial-draft="initialDraft"
        @cancel="returnToLedger()" @submit="save" />
    </template>
  </template>
</template>
