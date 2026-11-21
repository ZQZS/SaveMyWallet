<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Sparkles } from 'lucide-vue-next'
import type { LedgerData, MonthlySummary } from '../../domain/ledger'
import { formatMoney, formatMonth, locale, t } from '../../i18n'
import { toReminderFacts } from '../../integrations/ai/capabilities'
import { explainMonth } from '../../integrations/ai/deepseek'
import '../../shared/styles/ledger-forms.css'
import InstallmentScenario from './InstallmentScenario.vue'
import { useAssistantRequest } from './useAssistantRequest'

const props = defineProps<{ month: string; ledger: LedgerData; summary: MonthlySummary }>()
const open = ref(false)
const tab = ref<'explanation' | 'scenario'>('explanation')
const explanation = ref('')
const { pending, error, run, cancel } = useAssistantRequest()
const floor = computed(() => props.ledger.settings.warningFloorCents)
const gap = computed(() => props.summary.balance - floor.value)

watch([() => props.month, () => props.summary.balance, () => props.summary.due, floor, locale], () => {
  cancel()
  explanation.value = ''
})

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
  if (!open.value) cancel()
}

function explain() {
  const facts = toReminderFacts(props.month, props.summary, floor.value)
  explanation.value = ''
  return run(signal => explainMonth(facts, locale.value, signal), text => { explanation.value = text })
}

function selectTab(value: typeof tab.value) {
  if (value !== tab.value) cancel()
  tab.value = value
}
</script>

<template>
  <details class="monthly-assistant ledger-editor" @toggle="toggle">
    <summary>
      <Sparkles :size="18" aria-hidden="true" />
      <span>{{ t('ai.month.tools') }}</span>
      <ChevronDown class="disclosure" :size="18" aria-hidden="true" />
    </summary>
    <div v-if="open" class="assistant-body">
      <div class="ledger-type-switch" role="group" :aria-label="t('ai.month.tools')">
        <button v-for="name in (['explanation', 'scenario'] as const)" :key="name" type="button"
          :aria-pressed="tab === name" @click="selectTab(name)">{{ t('ai.month.' + name) }}</button>
      </div>
      <div v-if="tab === 'explanation'" class="monthly-insights">
        <p class="balance-note">
          {{ gap === 0 ? t('ai.month.balanceAtFloor') :
            t(gap < 0 ? 'ai.month.balanceBelow' : 'ai.month.balanceAbove', { amount: formatMoney(Math.abs(gap)) }) }}
        </p>
        <p class="ledger-hint">{{ t('ai.month.share', { month: formatMonth(month), balance: formatMoney(summary.balance),
          due: formatMoney(summary.due), floor: formatMoney(floor) }) }}</p>
        <div class="insight-actions">
          <button v-if="pending" type="button" class="ledger-secondary" @click="cancel">{{ t('forms.cancel') }}</button>
          <button v-else type="button" class="ledger-primary" @click="explain">{{ t('ai.month.explain') }}</button>
          <RouterLink :to="{ name: 'settings-ai' }">{{ t('ai.month.setup') }}</RouterLink>
        </div>
        <p v-if="pending" class="ledger-hint" role="status">{{ t('ai.month.wait') }}</p>
        <p v-if="error" class="ledger-error" role="alert">{{ error }}</p>
        <p v-if="explanation" class="assistant-reply" role="status">{{ explanation }}</p>
      </div>
      <InstallmentScenario v-else :month="month" :ledger="ledger" />
    </div>
  </details>
</template>

<style scoped>
.monthly-assistant { display: block; max-width: none; margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
.monthly-assistant summary { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 16px; cursor: pointer; color: var(--green); font-weight: 650; }
.monthly-assistant summary::-webkit-details-marker { display: none; }
.disclosure { margin-left: auto; flex: none; }
.monthly-assistant[open] .disclosure { transform: rotate(180deg); }
.assistant-body, .monthly-insights { display: grid; gap: 14px; min-width: 0; }
.assistant-body { padding: 0 16px 16px; }
.balance-note { font-weight: 600; }
.insight-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
.insight-actions a { color: var(--green); font-size: .875rem; }
.assistant-reply { background: var(--soft); color: var(--ink); border-radius: 8px; padding: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
