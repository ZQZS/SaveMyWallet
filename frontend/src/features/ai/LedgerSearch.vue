<script lang="ts">
import { defineComponent } from 'vue'
import type { LedgerSearchFilters } from './ledgerSearch'

interface SearchVisit {
  position: number
  detail: string
  referenceMonth: string
  question: string
  applied: LedgerSearchFilters
  extracted: boolean
  extraOpen: boolean
  shown: number
}

let previousSearch: SearchVisit | undefined

export default defineComponent({
  beforeRouteEnter(_to, from) {
    if (previousSearch?.detail !== from.fullPath) previousSearch = undefined
  },
})
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { MAX_MONTH, MIN_MONTH } from '../../domain/ledger'
import { formatMonth, t } from '../../i18n'
import { searchStatusKeys } from '../../i18n/messages/ledgerSearch'
import { parseLedgerSearch } from '../../integrations/ai/deepseek'
import '../../shared/styles/ledger-forms.css'
import { searchLedger } from './ledgerSearch'
import LedgerSearchResults from './LedgerSearchResults.vue'
import { useAssistantRequest } from './useAssistantRequest'

const { data: ledger, month } = useLedgerSession()
const history = useRouter().options.history
const position = history.state.position
// A new search opened from the same bill has a different history position.
const restored = previousSearch && previousSearch.position === position && previousSearch.detail === history.state.forward
  ? previousSearch : undefined
previousSearch = undefined
const referenceMonth = restored?.referenceMonth ?? month.value
const { run, pending, cancel, error } = useAssistantRequest()
const question = ref(restored?.question ?? '')
const filters = ref<LedgerSearchFilters>(restored?.applied ?? emptyFilters())
const applied = ref<LedgerSearchFilters | null>(restored?.applied ?? null)
const extraOpen = ref(restored?.extraOpen ?? false)
const extraction = ref<'idle' | 'review' | 'unsupported'>(restored?.extracted ? 'review' : 'idle')
const pageSize = 25
const shown = ref(restored?.shown ?? pageSize)
const result = computed(() => ledger.value && applied.value ? searchLedger(ledger.value, applied.value) : null)
const resultsView = ref<InstanceType<typeof LedgerSearchResults> | null>(null)

onBeforeRouteLeave(to => {
  if (to.name !== 'ledger' || typeof to.query.entry !== 'string' || typeof position !== 'number' ||
      history.state.position !== position || !applied.value || !result.value?.entries.some(entry => entry.id === to.query.entry)) return
  previousSearch = {
    position, detail: to.fullPath, referenceMonth, question: question.value,
    applied: { ...applied.value, statuses: [...applied.value.statuses] },
    extracted: extraction.value === 'review', extraOpen: extraOpen.value, shown: shown.value,
  }
})

async function focusResults() {
  await nextTick()
  resultsView.value?.focus()
}

function emptyFilters(): LedgerSearchFilters {
  return { fromMonth: null, toMonth: null, platform: null, title: null, kind: null, statuses: [],
    hasDeposit: null, outstandingOnly: false, voided: 'active' }
}

watch(filters, () => {
  applied.value = null
  extraction.value = 'idle'
  shown.value = pageSize
}, { deep: true, flush: 'sync' })

watch(question, () => {
  cancel()
  if (extraction.value === 'review') filters.value = emptyFilters()
  extraction.value = 'idle'
  applied.value = null
  shown.value = pageSize
}, { flush: 'sync' })

function extract() {
  const message = question.value.trim()
  if (!message || pending.value) return
  filters.value = emptyFilters()
  extraction.value = 'idle'
  return run(signal => parseLedgerSearch(message, referenceMonth, signal), ({ supported, ...draft }) => {
    if (supported !== true) {
      extraction.value = 'unsupported'
      return
    }
    filters.value = draft
    applied.value = draft
    if (!result.value) {
      filters.value = emptyFilters()
      extraction.value = 'unsupported'
      return
    }
    extraOpen.value = !!draft.kind || draft.statuses.length > 0 || draft.hasDeposit !== null ||
      draft.outstandingOnly || draft.voided !== 'active'
    extraction.value = 'review'
    void focusResults()
  })
}

function search() {
  if (pending.value) return
  cancel()
  extraction.value = 'idle'
  const draft = filters.value
  applied.value = { ...draft, fromMonth: draft.fromMonth || null, toMonth: draft.toMonth || null,
    platform: draft.platform?.trim() || null, title: draft.title?.trim() || null, statuses: [...draft.statuses] }
  if (result.value) void focusResults()
}
</script>

<template>
  <section v-if="ledger" class="ledger-editor" aria-labelledby="search-heading">
    <header class="ledger-form-head">
      <RouterLink class="ledger-back" :to="{ name: 'ledger' }" :aria-label="t('forms.back')"><ArrowLeft :size="20" /></RouterLink>
      <h1 id="search-heading">{{ t('ai.search.tab') }}</h1>
    </header>
    <form class="ledger-sheet search-intent" @submit.prevent="extract">
      <label class="ledger-field">
        <span>{{ t('ai.search.question') }}</span>
        <textarea v-model="question" name="searchQuestion" rows="2" maxlength="1000" :disabled="pending"
          :placeholder="t('ai.search.example')" />
      </label>
      <p class="ledger-hint">{{ t('ai.search.privacy', { month: formatMonth(referenceMonth) }) }}</p>
      <div class="search-actions">
        <button v-if="pending" class="ledger-secondary" type="button" @click="cancel">{{ t('forms.cancel') }}</button>
        <button v-else class="ledger-secondary" type="submit" :disabled="!question.trim()">{{ t('ai.search.extract') }}</button>
        <span v-if="pending" class="ledger-hint" role="status">{{ t('ai.month.wait') }}</span>
        <RouterLink v-if="error" :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
      </div>
      <p v-if="error" class="ledger-error" role="alert">{{ error }}</p>
      <p v-else-if="extraction === 'unsupported'" class="ledger-error" role="alert">{{ t('ai.search.unsupported') }}</p>
      <p v-else-if="extraction === 'review'" class="ledger-hint" role="status">{{ t('ai.search.review') }}</p>
    </form>
    <LedgerSearchResults v-if="result && applied" ref="resultsView" :result="result" :platforms="ledger.platforms"
      :filters="applied" :shown="shown" @more="shown += pageSize" />
    <form class="ledger-sheet" @submit.prevent="search">
      <h2>{{ t('ai.search.filters') }}</h2>
      <fieldset class="search-fields" :disabled="pending">
        <div class="ledger-fields">
          <label class="ledger-field"><span>{{ t('ai.search.fromMonth') }}</span>
            <input v-model="filters.fromMonth" name="fromMonth" type="month" :min="MIN_MONTH" :max="MAX_MONTH" />
          </label>
          <label class="ledger-field"><span>{{ t('ai.search.toMonth') }}</span>
            <input v-model="filters.toMonth" name="toMonth" type="month" :min="filters.fromMonth || MIN_MONTH" :max="MAX_MONTH" />
          </label>
          <label class="ledger-field"><span>{{ t('forms.platform') }}</span>
            <input v-model="filters.platform" name="platform" list="search-platforms" maxlength="40" :placeholder="t('ai.search.any')" />
          </label>
          <datalist id="search-platforms"><option v-for="p in ledger.platforms" :key="p.id" :value="p.name" /></datalist>
          <label class="ledger-field"><span>{{ t('ai.search.title') }}</span>
            <input v-model="filters.title" name="title" maxlength="120" :placeholder="t('ai.search.any')" />
          </label>
        </div>
        <details :open="extraOpen" @toggle="extraOpen = ($event.currentTarget as HTMLDetailsElement).open">
          <summary>{{ t('ai.search.moreFilters') }}</summary>
          <div class="ledger-fields extra-fields">
            <label class="ledger-field"><span>{{ t('forms.typeLabel') }}</span>
              <select v-model="filters.kind" name="kind">
                <option :value="null">{{ t('ai.search.any') }}</option>
                <option v-for="kind in (['single', 'installment', 'estimate'] as const)" :key="kind" :value="kind">{{ t('forms.' + kind) }}</option>
              </select>
            </label>
            <label class="ledger-field"><span>{{ t('ai.search.deposit') }}</span>
              <select v-model="filters.hasDeposit" name="hasDeposit">
                <option :value="null">{{ t('ai.search.any') }}</option>
                <option :value="true">{{ t('ai.search.withDeposit') }}</option>
                <option :value="false">{{ t('ai.search.withoutDeposit') }}</option>
              </select>
            </label>
            <label class="ledger-field"><span>{{ t('ai.search.records') }}</span>
              <select v-model="filters.voided" name="records">
                <option value="active">{{ t('ai.search.active') }}</option>
                <option value="voided">{{ t('ledger.voided') }}</option>
                <option value="all">{{ t('ai.search.all') }}</option>
              </select>
            </label>
            <fieldset class="statuses"><legend>{{ t('ledger.status') }}</legend>
              <div class="choices">
                <label v-for="(label, status) in searchStatusKeys" :key="status" class="choice">
                  <input v-model="filters.statuses" type="checkbox" name="statuses" :value="status" />{{ t(label) }}
                </label>
              </div>
            </fieldset>
            <label class="choice ledger-wide"><input v-model="filters.outstandingOnly" name="outstandingOnly" type="checkbox" />{{ t('ai.search.outstanding') }}</label>
          </div>
        </details>
      </fieldset>
      <p v-if="applied && !result" class="ledger-error" role="alert">{{ t('ai.search.invalid') }}</p>
      <div class="search-actions"><button class="ledger-primary" type="submit" :disabled="pending">{{ t('ai.search.run') }}</button></div>
    </form>
  </section>
</template>

<style scoped>
.search-intent { gap: 12px; }
textarea { min-width: 0; padding: 10px 12px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); font: inherit; font-weight: 400; }
:is(textarea, summary, a):focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.search-actions, .choices, .choice { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.search-actions a { color: var(--green); font-size: .875rem; }
fieldset { margin: 0; min-width: 0; padding: 0; border: 0; }
.search-fields { display: grid; gap: 14px; }
summary { cursor: pointer; color: var(--green); font-weight: 600; font-size: .875rem; }
.extra-fields { margin-top: 14px; }
legend { margin-bottom: 6px; padding: 0; font-size: .875rem; font-weight: 600; }
.choice { flex-wrap: nowrap; gap: 6px; min-height: 32px; font-size: .875rem; }
.choice input { width: 17px; min-height: 17px; height: 17px; accent-color: var(--accent-solid); margin: 0; flex: none; }
@media (max-width: 480px) { .ledger-fields { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
</style>
