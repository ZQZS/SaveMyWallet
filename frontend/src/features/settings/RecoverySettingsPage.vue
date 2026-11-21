<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { useLedgerSession } from '../../app/ledgerSession'
import { useSyncSession } from '../../app/syncSession'
import { currentMonth } from '../../domain/ledger'
import { displayError, locale, t } from '../../i18n'
import { localBackup, type LedgerRestorePoint } from './backupService'
import AiUndoPanel from './AiUndoPanel.vue'
import SettingsPageFrame from './SettingsPageFrame.vue'

const ledger = useLedgerSession()
const sync = useSyncSession()
const points = shallowRef<LedgerRestorePoint[]>([])
const selected = shallowRef<LedgerRestorePoint | null>(null)
const loading = ref(false)
const readError = ref('')
const busy = computed(() => loading.value || ledger.busy.value || ledger.needsReload.value)
const bound = computed(() => sync.status.value?.bound === true)
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'long', timeZone: 'UTC' }))
const displayDate = (date: string) => dateFormat.value.format(new Date(date + 'T00:00:00Z'))
let opener: HTMLButtonElement | null = null
let request = 0
let timer: number
const localDate = ref('')

async function load(daysAgo?: LedgerRestorePoint['daysAgo']) {
  const current = ++request
  selected.value = null
  readError.value = ''
  loading.value = true
  try {
    const fresh = await localBackup.listRestorePoints()
    if (current !== request) return
    points.value = fresh
    if (daysAgo) {
      const point = fresh.find(point => point.daysAgo === daysAgo)
      if (point?.preview) {
        selected.value = point
        await nextTick()
        document.getElementById('recovery-preview-title')?.focus()
      } else {
        readError.value = displayError('HISTORY_UNAVAILABLE')
      }
    }
  } catch (cause) {
    if (current !== request) return
    points.value = []
    readError.value = displayError(cause)
  } finally {
    if (current === request) loading.value = false
  }
}

function preview(point: LedgerRestorePoint, event: Event) {
  opener = event.currentTarget as HTMLButtonElement
  ledger.error.value = ''
  ledger.notice.value = ''
  void load(point.daysAgo)
}

function closePreview() {
  selected.value = null
  void nextTick(() => opener?.focus())
}

async function restore() {
  const point = selected.value
  if (!point?.preview || busy.value || bound.value || sync.busy.value) return
  await ledger.commit(async () => {
    try {
      await localBackup.restorePoint(point)
    } catch (cause) {
      // Invalidate the old approval before another attempt. Native code also checks
      // the ledger revision, the requested day and the sync binding at write time.
      void load()
      if (String(cause) === 'SYNC_BOUND') void sync.load()
      throw cause
    }
  }, () => {
    closePreview()
    ledger.selectMonth(currentMonth())
    ledger.notice.value = t('settings.recovery.done', { date: displayDate(point.date) })
    void load()
  })
}

function refreshDate() {
  const now = new Date()
  const day = now.toDateString()
  if (day !== localDate.value) {
    localDate.value = day
    void load()
  }
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  window.clearTimeout(timer)
  timer = window.setTimeout(refreshDate, midnight.getTime() - now.getTime())
}
onMounted(() => {
  refreshDate()
  window.addEventListener('focus', refreshDate)
  document.addEventListener('visibilitychange', refreshDate)
})
onUnmounted(() => {
  ++request
  window.clearTimeout(timer)
  window.removeEventListener('focus', refreshDate)
  document.removeEventListener('visibilitychange', refreshDate)
})
</script>

<template>
  <SettingsPageFrame :title="t('settings.recovery.title')">
    <AiUndoPanel :day="localDate" :daily-preview-open="!!selected" @review="selected = null" />
    <p class="settings-muted">{{ t('settings.recovery.timing') }}</p>
    <p v-if="readError" class="settings-error" role="alert">
      {{ readError }}
      <button type="button" class="settings-button" :disabled="busy" @click="load()">{{ t('app.retry') }}</button>
    </p>
    <p v-if="loading && !points.length" role="status">{{ t('settings.recovery.loading') }}</p>
    <p v-if="bound" class="settings-warning">{{ t('sync.maintenance') }}
      <RouterLink :to="{ name: 'settings-connections' }">{{ t('settings.connections.title') }}</RouterLink>
    </p>
    <section v-for="point in points" :key="point.daysAgo" class="settings-sheet" :aria-labelledby="'point-' + point.daysAgo">
      <div class="point-row">
        <div>
          <h2 :id="'point-' + point.daysAgo">{{ t(point.daysAgo === 1 ? 'settings.recovery.yesterday' : 'settings.recovery.week') }}</h2>
          <p class="settings-muted"><time :datetime="point.date">{{ displayDate(point.date) }}</time> ·
            {{ t(point.preview ? 'settings.recovery.available' : 'settings.recovery.unavailable') }}
          </p>
        </div>
        <button type="button" class="settings-button" :disabled="busy || !point.preview"
          :aria-expanded="selected?.daysAgo === point.daysAgo" @click="preview(point, $event)">{{ t('settings.recovery.preview') }}</button>
      </div>
      <section v-if="selected?.daysAgo === point.daysAgo && selected.preview" id="recovery-preview" class="settings-preview" aria-labelledby="recovery-preview-title">
        <h3 id="recovery-preview-title" tabindex="-1">{{ t('settings.recovery.previewTitle', { date: displayDate(selected.date) }) }}</h3>
        <dl class="settings-counts">
          <div><dt>{{ t('settings.backup.platforms') }}</dt><dd>{{ selected.preview.platforms }}</dd></div>
          <div><dt>{{ t('settings.backup.entries') }}</dt><dd>{{ selected.preview.entries }}</dd></div>
          <div><dt>{{ t('settings.backup.overrides') }}</dt><dd>{{ selected.preview.overrides }}</dd></div>
        </dl>
        <p class="settings-warning">{{ t('settings.recovery.replace') }}</p>
        <div class="settings-actions">
          <button type="button" class="settings-button" :disabled="busy" @click="closePreview">{{ t('settings.action.cancel') }}</button>
          <button type="button" class="settings-button confirm-danger" :disabled="busy || bound || sync.busy.value" @click="restore">{{ t('settings.recovery.confirm') }}</button>
        </div>
      </section>
    </section>
    <p v-if="points.some(point => !point.preview)" class="settings-muted">{{ t('settings.recovery.historyHint') }}</p>
  </SettingsPageFrame>
</template>

<style scoped>
.point-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.point-row h2 { margin-bottom: 4px; }
</style>
