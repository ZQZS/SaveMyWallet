<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { isMonth, MAX_MONTH, MIN_MONTH, type Entry } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import { readBillAmounts } from '../bills/billAmounts'
import { findNoticeCandidates, prepareNoticeReview, type NoticeDraft } from './noticeMatch'
import NoticeSource from './NoticeSource.vue'
import '../../shared/styles/ledger-forms.css'

const router = useRouter()
const { data, month, busy, needsReload, commit, repository, retryRead, selectMonth, error, notice } = useLedgerSession()
const locked = computed(() => busy.value || needsReload.value)
const draft = ref<NoticeDraft | null>(null)
const source = ref({ text: '', image: '' })
const selected = shallowRef<Entry | null>(null)
const actualMonth = ref('')
const totalPrice = ref('')
const deposit = ref('')
const conflict = ref(false)
const stale = ref(false)
const submitted = ref(false)
const candidates = computed(() => data.value && draft.value ? findNoticeCandidates(data.value, draft.value) : [])
const platformNames = computed(() => new Map(data.value?.platforms.map(p => [p.id, p.name])))
const reviewedAmounts = computed(() => readBillAmounts('estimate', '', totalPrice.value, deposit.value))
const amountError = computed(() => typeof reviewedAmounts.value === 'string' ? reviewedAmounts.value : '')
const newBalance = computed(() => typeof reviewedAmounts.value === 'string' ? null : reviewedAmounts.value.amountCents)
const delta = computed(() => newBalance.value !== null && selected.value ? newBalance.value - selected.value.amountCents : null)
const saved = ref<{ id: string; month: string; amountCents: number } | null>(null)

function startReview(result: NoticeDraft, original: { text: string; image: string }) {
  draft.value = { ...result }
  source.value = original
  chooseEstimate('')
}

function chooseEstimate(id: string) {
  stale.value = false
  submitted.value = false
  const candidate = candidates.value.find(({ entry }) => entry.id === id)?.entry
  selected.value = candidate ? { ...candidate } : null
  if (!candidate || !draft.value) return
  const initial = prepareNoticeReview(candidate, draft.value)
  actualMonth.value = initial.month
  totalPrice.value = initial.totalPrice
  deposit.value = initial.deposit
  conflict.value = initial.conflict
}

function originalEstimateMonth(entry: Entry) {
  return entry.carriedFromMonth ?? entry.month
}

function current(entry: Entry) {
  const latest = candidates.value.find(candidate => candidate.entry.id === entry.id)?.entry
  return !!latest && latest.platformId === entry.platformId && latest.title === entry.title
    && originalEstimateMonth(latest) === originalEstimateMonth(entry)
    && latest.amountCents === entry.amountCents && (latest.depositCents ?? 0) === (entry.depositCents ?? 0)
}

function discardStale() {
  chooseEstimate('')
  stale.value = true
}

watch(data, () => {
  if (!saved.value && !locked.value && selected.value && !current(selected.value)) discardStale()
})

function backToSource() {
  if (locked.value) return
  selected.value = null
  draft.value = null
  source.value = { text: '', image: '' }
}

async function showSaved() {
  const receipt = saved.value
  if (!receipt || locked.value) return
  selectMonth(receipt.month)
  const failure = await router.push({ name: 'ledger', query: { entry: receipt.id } })
  if (!failure) notice.value = t(receipt.amountCents === 0 ? 'forms.coveredEstimateConfirmed' : 'forms.estimateConfirmed')
}

function confirm() {
  const entry = selected.value
  if (!entry || locked.value || saved.value) return
  if (!current(entry)) return discardStale()
  submitted.value = true
  const amounts = reviewedAmounts.value
  if (!isMonth(actualMonth.value) || typeof amounts === 'string') return
  const input = { id: entry.id, title: entry.title, month: actualMonth.value, ...amounts }
  void commit(() => repository.confirmEstimate(input), () => {
    saved.value = input
    void showSaved()
  })
}
</script>

<template>
  <section v-if="data" class="ledger-editor" aria-labelledby="notice-heading">
    <header class="ledger-form-head">
      <button type="button" class="ledger-back" :aria-label="t('forms.back')" :disabled="locked" @click="router.push({ name: 'ledger' })">
        <ArrowLeft :size="19" aria-hidden="true" />
      </button>
      <h1 id="notice-heading">{{ t('notice.open') }}</h1>
    </header>

    <NoticeSource v-show="!draft" :reference-month="month" :locked="locked" @review="startReview" />

    <template v-if="draft && !saved">
      <section class="ledger-sheet" aria-labelledby="notice-original">
        <h2 id="notice-original">{{ t('notice.find') }}</h2>
        <details v-if="source.image || source.text" class="notice-source">
          <summary>{{ t('notice.original') }}</summary>
          <img v-if="source.image" class="notice-preview" :src="source.image" :alt="t('notice.preview')" />
          <p v-else>{{ source.text }}</p>
        </details>
        <div class="ledger-fields">
          <label class="ledger-field">{{ t('notice.platformHint') }}
            <input v-model="draft.platformHint" maxlength="80" :disabled="locked" @input="chooseEstimate('')" />
          </label>
          <label class="ledger-field">{{ t('notice.titleHint') }}
            <input v-model="draft.title" maxlength="120" :disabled="locked" @input="chooseEstimate('')" />
          </label>
        </div>
        <label v-if="candidates.length" class="ledger-field">
          {{ t('notice.select') }}
          <select :value="selected?.id ?? ''" :disabled="locked" @change="chooseEstimate(($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('notice.choose') }}</option>
            <option v-for="{ entry, matched } in candidates" :key="entry.id" :value="entry.id">
              {{ matched ? t('notice.match') + ' · ' : '' }}{{ platformNames.get(entry.platformId) }} · {{ entry.title }} · {{ formatMonth(originalEstimateMonth(entry)) }}
              · {{ t('ledger.paidDeposit') }} {{ formatMoney(entry.depositCents ?? 0) }} · {{ t('ledger.balancePayment') }} {{ formatMoney(entry.amountCents) }}
            </option>
          </select>
        </label>
        <p v-else class="ledger-hint" role="status">{{ t('notice.empty') }}</p>
        <p v-if="stale" role="alert" class="ledger-error">{{ t('notice.stale') }}</p>
        <button type="button" class="ledger-text-btn notice-restart" :disabled="locked" @click="backToSource">{{ t('notice.changeSource') }}</button>
      </section>

      <form v-if="selected" class="ledger-sheet" novalidate aria-labelledby="notice-review" @submit.prevent="confirm">
        <h2 id="notice-review">{{ t('notice.review') }}</h2>
        <dl class="notice-values">
          <div><dt>{{ t('forms.platform') }}</dt><dd>{{ platformNames.get(selected.platformId) }}</dd></div>
          <div><dt>{{ t('forms.title') }}</dt><dd>{{ selected.title }}</dd></div>
          <div><dt>{{ t('forms.monthEstimated') }}</dt><dd>{{ formatMonth(originalEstimateMonth(selected)) }}</dd></div>
          <div><dt>{{ t('notice.oldDeposit') }}</dt><dd>{{ formatMoney(selected.depositCents ?? 0) }}</dd></div>
        </dl>
        <div v-if="draft.amountCents !== null || draft.totalCents !== null || draft.depositCents !== null" class="notice-evidence">
          <strong>{{ t('notice.detected') }}</strong>
          <span v-if="draft.amountCents !== null">{{ t('ledger.balancePayment') }} {{ formatMoney(draft.amountCents) }}</span>
          <span v-if="draft.totalCents !== null">{{ t('ledger.estimateTotal') }} {{ formatMoney(draft.totalCents) }}</span>
          <span v-if="draft.depositCents !== null">{{ t('ledger.paidDeposit') }} {{ formatMoney(draft.depositCents) }}</span>
        </div>
        <p v-if="conflict && amountError" class="ledger-error" role="status">{{ t('notice.conflict') }}</p>
        <div class="ledger-fields">
          <label class="ledger-field">{{ t('forms.monthConfirmed') }}
            <input v-model="actualMonth" type="month" :min="MIN_MONTH" :max="MAX_MONTH" :disabled="locked" required />
          </label>
          <label class="ledger-field">{{ t('forms.estimateTotal') }}
            <input v-model="totalPrice" inputmode="decimal" :disabled="locked" required />
          </label>
          <label class="ledger-field">{{ t('forms.paidDeposit') }}
            <input v-model="deposit" inputmode="decimal" :disabled="locked" />
          </label>
        </div>
        <dl class="notice-values notice-comparison">
          <div><dt>{{ t('notice.oldBalance') }}</dt><dd>{{ formatMoney(selected.amountCents) }}</dd></div>
          <div><dt>{{ t('notice.newBalance') }}</dt><dd>{{ newBalance !== null ? formatMoney(newBalance) : '—' }}</dd></div>
          <div><dt>{{ t('notice.delta') }}</dt><dd>{{ delta === null ? '—' : (delta > 0 ? '+' : '') + formatMoney(delta) }}</dd></div>
        </dl>
        <p v-if="submitted && !isMonth(actualMonth)" class="ledger-error" role="alert">{{ t('forms.monthError') }}</p>
        <p v-if="submitted && amountError" class="ledger-error" role="alert">{{ t(amountError) }}</p>
        <p v-if="newBalance === 0" role="status" class="ledger-hint">{{ t('notice.covered') }}</p>
        <div class="ledger-form-actions">
          <button v-if="error && !needsReload" type="button" class="ledger-secondary" :disabled="locked" @click="retryRead">{{ t('notice.reload') }}</button>
          <button type="submit" class="ledger-primary" :disabled="locked">{{ t('notice.confirm') }}</button>
        </div>
      </form>
    </template>
    <button v-if="saved" class="ledger-secondary" type="button" @click="showSaved">{{ t('notice.show') }}</button>
  </section>
</template>

<style scoped>
.notice-source { min-width: 0; }
.notice-source summary { color: var(--green); cursor: pointer; }
.notice-source p { margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice-preview { width: 100%; max-height: 45vh; object-fit: contain; background: var(--soft); border-radius: 8px; }
.notice-restart { justify-self: start; }
.notice-values { display: grid; grid-template-columns: repeat(auto-fit, minmax(115px, 1fr)); gap: 12px 18px; margin: 0; }
.notice-values dt, .notice-evidence { color: var(--sub); font-size: .85rem; }
.notice-values dd { margin: 4px 0 0; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.notice-comparison { padding: 14px; border-radius: 9px; background: var(--soft); }
.notice-evidence { display: flex; flex-wrap: wrap; gap: 4px 14px; }
</style>
