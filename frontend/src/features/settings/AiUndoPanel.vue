<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { useSyncSession } from '../../app/syncSession'
import { displayError, formatMonth, locale, t } from '../../i18n'
import { localBackup, type AiUndoPreview } from './backupService'

const props = defineProps<{ day: string; dailyPreviewOpen: boolean }>()
const emit = defineEmits<{ review: [] }>()
const ledger = useLedgerSession()
const sync = useSyncSession()
const latest = shallowRef<AiUndoPreview | null>(null)
const reviewing = ref(false)
const loading = ref(true)
const readError = ref('')
const previewButton = ref<HTMLButtonElement | null>(null)
const heading = ref<HTMLElement | null>(null)
const busy = computed(() => loading.value || ledger.busy.value || ledger.needsReload.value || sync.busy.value)
const timestamp = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))
const total = computed(() => latest.value ? latest.value.entryCount + latest.value.platformCount + latest.value.budgetCount : 0)
let generation = 0
let disposed = false

function itemLabel(item: AiUndoPreview['items'][number]) {
  if (item.kind === 'override') return t('forms.salaryOverride', { month: formatMonth(item.label) })
  if (item.kind === 'setting') return t(item.label === 'defaultSalaryCents' ? 'ledger.defaultSalary' : 'forms.floor')
  return item.label
}

async function load(open = false) {
  if (disposed) return
  const current = ++generation
  if (open) {
    ledger.error.value = ''
    ledger.notice.value = ''
  }
  reviewing.value = false
  readError.value = ''
  loading.value = true
  try {
    const fresh = await localBackup.previewAiUndo()
    if (generation !== current) return
    latest.value = fresh
    if (open && fresh) {
      emit('review')
      reviewing.value = true
      await nextTick()
      heading.value?.focus()
    }
  } catch (cause) {
    if (generation !== current) return
    latest.value = null
    readError.value = displayError(cause)
  } finally {
    if (generation === current) loading.value = false
  }
}

function close() {
  reviewing.value = false
  void nextTick(() => previewButton.value?.focus())
}

async function confirm() {
  const change = latest.value
  if (!reviewing.value || !change || change.blocked || busy.value) return
  await ledger.commit(async () => {
    try {
      await localBackup.undoAiChange(change.token)
    } catch (cause) {
      void load()
      throw cause
    }
  }, () => {
    ledger.reconcilePaymentUndo()
    ledger.notice.value = t('settings.aiUndo.done')
  })
}

watch([() => props.day, ledger.writeCount], () => { if (props.day) void load() }, { immediate: true })
watch(() => props.dailyPreviewOpen, open => { if (open) reviewing.value = false })
onUnmounted(() => {
  disposed = true
  generation++
})
</script>

<template>
  <section id="ai-undo" class="settings-sheet" aria-labelledby="ai-undo-title">
    <h2 id="ai-undo-title">{{ t('settings.aiUndo.title') }}</h2>
    <p v-if="readError" class="settings-error" role="alert">
      {{ readError }}
      <button type="button" class="settings-button" :disabled="busy" @click="load()">{{ t('app.retry') }}</button>
    </p>
    <p v-else-if="loading && !latest" class="settings-muted" role="status">{{ t('settings.aiUndo.loading') }}</p>
    <p v-else-if="!latest" class="settings-muted">{{ t('settings.aiUndo.empty') }}</p>
    <template v-else>
      <p class="settings-muted">
        {{ t('chat.action.' + latest.action) }} ·
        <time :datetime="new Date(latest.createdAt).toISOString()">{{ timestamp.format(latest.createdAt) }}</time>
      </p>
      <div v-if="!reviewing" class="settings-actions">
        <button ref="previewButton" id="preview-ai-undo" type="button" class="settings-button"
          :disabled="busy" @click="load(true)">{{ t('settings.aiUndo.preview') }}</button>
      </div>
      <div v-else id="ai-undo-preview" class="settings-preview" aria-labelledby="ai-undo-preview-title">
        <h3 ref="heading" id="ai-undo-preview-title" tabindex="-1">{{ t('settings.aiUndo.scope') }}</h3>
        <dl class="settings-counts">
          <div v-if="latest.entryCount"><dt>{{ t('settings.backup.entries') }}</dt><dd>{{ latest.entryCount }}</dd></div>
          <div v-if="latest.platformCount"><dt>{{ t('settings.backup.platforms') }}</dt><dd>{{ latest.platformCount }}</dd></div>
          <div v-if="latest.budgetCount"><dt>{{ t('settings.aiUndo.budget') }}</dt><dd>{{ latest.budgetCount }}</dd></div>
        </dl>
        <ul v-if="latest.items.length" class="undo-items">
          <li v-for="item in latest.items" :key="item.kind + ':' + item.id">{{ itemLabel(item) }}</li>
        </ul>
        <p v-if="latest.items.length < total" class="settings-muted">{{ t('settings.aiUndo.sample', { count: latest.items.length, total }) }}</p>
        <p v-if="latest.blocked" class="settings-warning" role="status">{{ displayError(latest.blockedReason || 'AI_UNDO_CONFLICT') }}</p>
        <p v-else class="settings-muted">{{ t('settings.aiUndo.explain') }}</p>
        <div class="settings-actions">
          <button id="cancel-ai-undo" type="button" class="settings-button" :disabled="busy" @click="close">{{ t('settings.action.cancel') }}</button>
          <button id="confirm-ai-undo" type="button" class="settings-button confirm-danger" :disabled="busy || latest.blocked" @click="confirm">{{ t('settings.aiUndo.confirm') }}</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.undo-items { margin: 0; padding-inline-start: 1.4em; overflow-wrap: anywhere; font-size: .93rem; line-height: 1.55; }
</style>
