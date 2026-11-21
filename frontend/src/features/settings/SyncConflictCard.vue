<script setup lang="ts">
import { computed } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { estimateTotalCents, isMonth } from '../../domain/ledger'
import { formatMoney, formatMonth, t } from '../../i18n'
import type { SyncConflict } from './sync/syncTypes'

const props = defineProps<{ conflict: SyncConflict; disabled: boolean }>()
const emit = defineEmits<{ resolve: [choice: 'local' | 'server'] }>()
const { data } = useLedgerSession()
const sides = ['base', 'local', 'server'] as const
const platformNames = computed(() => new Map(data.value?.platforms.map(item => [item.id, item.name])))
const statuses: Record<string, string> = {
  due: 'ledger.unpaid', paid: 'ledger.paid', estimated: 'ledger.needsConfirmation',
}
type Detail = { label: string; text: string }

function details(kind: string, value: unknown): Detail[] {
  if (value == null) return [{ label: '', text: t(kind === 'override' ? 'syncConflict.inherit' : 'syncConflict.absent') }]
  if (typeof value === 'number') return [{ label: 'syncConflict.amount', text: formatMoney(value) }]
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (kind === 'platform') return [{ label: 'syncConflict.platformName', text: String(record.name) }]
    if (kind === 'entry') {
      const month = String(record.month)
      const platformId = String(record.platformId)
      const type = String(record.kind)
      const amountCents = Number(record.amountCents)
      const depositCents = Number(record.depositCents ?? 0)
      const amounts = type === 'estimate' ? [
        { label: 'ledger.estimateTotal', text: formatMoney(estimateTotalCents({ amountCents, depositCents })) },
        { label: 'ledger.paidDeposit', text: formatMoney(depositCents) },
        { label: 'ledger.balancePayment', text: formatMoney(amountCents) },
      ] : [{ label: 'syncConflict.amount', text: formatMoney(amountCents) }]
      return [
        { label: 'forms.title', text: String(record.title) },
        { label: 'forms.monthDue', text: isMonth(month) ? formatMonth(month) : month },
        ...amounts,
        { label: 'syncConflict.entryState', text: t(record.voided ? 'ledger.voided' : 'syncConflict.active') },
        { label: 'syncConflict.paymentStatus', text: t(statuses[String(record.status)] ?? String(record.status)) },
        { label: 'forms.platform', text: platformNames.value.get(platformId) ?? platformId },
        { label: 'forms.typeLabel', text: type === 'installment'
          ? t('ledger.installment', { index: Number(record.installmentIndex), count: Number(record.installmentCount) })
          : t('forms.' + type) },
      ]
    }
  }
  return [{ label: '', text: JSON.stringify(value) }]
}

function changeHeading(kind: string, id: string) {
  if (kind === 'entry') return t('syncConflict.entry')
  if (kind === 'platform') return t('forms.platform')
  if (kind === 'override' && isMonth(id)) return t('syncConflict.monthIncome', { month: formatMonth(id) })
  if (kind === 'setting') return t(id === 'defaultSalaryCents' ? 'ledger.defaultSalary' : 'syncConflict.floor')
  return id
}

const comparisons = computed(() => {
  const records = new Map(props.conflict.records.map(record => [record.kind + ':' + record.id, record.value]))
  return props.conflict.changes.map(change => {
    const key = change.kind + ':' + change.id
    const local = details(change.kind, change.after)
    const server = details(change.kind, records.get(key))
    const changedFields = new Set<string>()
    for (const field of [...local, ...server]) {
      if (local.find(row => row.label === field.label)?.text !== server.find(row => row.label === field.label)?.text) {
        changedFields.add(field.label)
      }
    }
    return { key, heading: changeHeading(change.kind, change.id), base: details(change.kind, change.before), local, server, changedFields }
  })
})
</script>

<template>
  <section class="settings-sheet conflict-card" :aria-label="t('syncConflict.title')">
    <h3>{{ t('syncConflict.title') }}</h3>
    <p class="settings-muted">{{ t('syncConflict.scope', { count: comparisons.length }) }}</p>
    <section v-for="item in comparisons" :key="item.key" class="record">
      <h4>{{ item.heading }}</h4>
      <div class="comparison">
        <section v-for="side in sides" :key="side" class="version">
          <h5>{{ t('syncConflict.' + side) }}</h5>
          <dl>
            <div v-for="field in item[side]" :key="field.label">
              <dt>{{ field.label ? t(field.label) : t('syncConflict.value') }}</dt>
              <dd :class="{ differs: side !== 'base' && item.changedFields.has(field.label) }">{{ field.text }}</dd>
            </div>
          </dl>
        </section>
      </div>
    </section>
    <p v-if="conflict.requiresRestore" class="settings-muted">{{ t('error.SYNC_ENTRY_VOIDED') }}</p>
    <div class="settings-actions">
      <button class="settings-button" type="button" :disabled="disabled || conflict.requiresRestore" @click="emit('resolve', 'local')">{{ t('syncConflict.keepLocal') }}</button>
      <button class="settings-button" type="button" :disabled="disabled" @click="emit('resolve', 'server')">{{ t('syncConflict.keepServer') }}</button>
    </div>
  </section>
</template>

<style scoped>
.conflict-card { overflow-wrap: anywhere; }
.record { min-width: 0; padding-block-start: 12px; border-block-start: 1px solid var(--line); }
.record h4, .version h5 { margin: 0 0 8px; font-size: .93rem; }
.comparison { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.version { min-width: 0; border: 1px solid var(--line); border-radius: 9px; padding: 12px; }
.version dl { margin: 0; display: grid; gap: 6px; }
.version dt { color: var(--sub); font-size: .78rem; }
.version dd { margin: 2px 0 0; font-size: .9rem; font-variant-numeric: tabular-nums; }
.version dd.differs { font-weight: 700; }
@media (max-width: 610px) {
  .comparison { grid-template-columns: 1fr; }
  .version dl > div { display: grid; grid-template-columns: minmax(7em, 2fr) minmax(0, 3fr); gap: 8px; align-items: baseline; }
  .version dd { margin: 0; }
}
</style>
