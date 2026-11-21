<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { BookOpen } from 'lucide-vue-next'
import type { PlatformGroup, Entry } from '../../../domain/ledger'
import { formatMoney, t } from '../../../i18n'
import PlatformRepaymentGroup from './PlatformRepaymentGroup.vue'

const props = defineProps<{ groups: PlatformGroup[]; paid: number; busy: boolean; linkedEntry?: Entry }>()
const emit = defineEmits<{
  pay: [ids: string[], paid: boolean]
  confirm: [entry: Entry]
  setVoided: [entry: Entry, voided: boolean]
}>()
const expanded = ref<string | null>(null)
const checklist = ref<HTMLElement | null>(null)

watch([() => props.linkedEntry?.id, () => props.linkedEntry?.platformId], async ([id, platformId]) => {
  if (!id || !platformId) return
  expanded.value = platformId
  await nextTick()
  if (props.linkedEntry?.id !== id) return
  const row = checklist.value?.querySelector<HTMLElement>('.linked-entry')
  if (row) {
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'center' })
  }
}, { immediate: true })

function toggleGroup(id: string) {
  expanded.value = expanded.value === id ? null : id
}
</script>

<template>
  <section ref="checklist" class="ledger-section" aria-labelledby="repayments-heading">
    <div class="section-heading">
      <h2 id="repayments-heading">{{ t('ledger.checklist') }}</h2>
      <span class="platform-count">{{ t('ledger.platformCount', { count: groups.length, amount: formatMoney(paid) }) }}</span>
    </div>
    <template v-if="groups.length">
      <div aria-hidden="true" class="list-head">
        <span>{{ t('ledger.paid') }}</span><span>{{ t('ledger.platformDetails') }}</span>
        <span>{{ t('ledger.total') }}</span><span>{{ t('ledger.status') }}</span>
      </div>
      <ul class="platform-list">
        <PlatformRepaymentGroup v-for="group in groups" :key="group.platform.id"
          :group="group" :expanded="expanded === group.platform.id" :busy="busy" :linked-id="linkedEntry?.id"
          @toggle="toggleGroup(group.platform.id)" @pay="(ids, paid) => emit('pay', ids, paid)"
          @confirm="emit('confirm', $event)" @set-voided="(entry, voided) => emit('setVoided', entry, voided)" />
      </ul>
    </template>
    <div v-else class="empty-state">
      <BookOpen class="empty-icon" :size="25" :stroke-width="1.6" aria-hidden="true" />
      <strong>{{ t('ledger.emptyTitle') }}</strong>
      <span>{{ t('ledger.emptyHelp') }}</span>
    </div>
  </section>
</template>

<style scoped>
.ledger-section {
  --check-width: 44px;
  --column-gap: 12px;
  --row-padding: 20px;
  --content-columns: minmax(0, 1fr) minmax(90px, .38fr) minmax(115px, .4fr);
  overflow: hidden; border: 1px solid var(--line); border-radius: 15px; background: var(--surface);
}
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px var(--row-padding) 15px; flex-wrap: wrap; }
.section-heading h2 { font-size: 1.12rem; letter-spacing: -0.02em; font-weight: 680; }
.platform-count { color: var(--sub); font-size: 0.8rem; }
.list-head {
  display: grid; grid-template-columns: var(--check-width) var(--content-columns); align-items: center;
  gap: var(--column-gap); padding: 7px var(--row-padding); border-block: 1px solid var(--line);
  background: var(--paper); color: var(--sub); font-size: 0.75rem;
}
.list-head > :first-child { text-align: center; }
.list-head > :nth-child(3) { text-align: right; }
.list-head > :last-child { text-align: right; padding-right: 24px; }
.platform-list { list-style: none; margin: 0; padding: 0; }
.empty-state { display: grid; justify-items: center; gap: 6px; padding: 36px 16px 42px; text-align: center; border-top: 1px solid var(--line); }
.empty-icon { color: var(--green); margin-bottom: 5px; }
.empty-state span { color: var(--sub); font-size: 0.85rem; }
@media (max-width: 650px) {
  .ledger-section { --row-padding: 8px; --check-width: 36px; --column-gap: 4px; }
  .section-heading { padding: 13px 12px; border-bottom: 1px solid var(--line); gap: 4px 10px; }
  .list-head { display: none; }
  .empty-state { border-top: 0; padding-block: 30px; }
}
</style>
