<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { FileDown, FileUp } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { useSyncSession } from '../../app/syncSession'
import { currentMonth } from '../../domain/ledger'
import { displayError, t } from '../../i18n'
import { chooseBackupFile, saveBackupFile } from './backupFiles'
import { localBackup } from './backupService'
import SettingsPageFrame from './SettingsPageFrame.vue'

interface SelectedBackup {
  name: string
  contents: string
  counts: Awaited<ReturnType<typeof localBackup.previewBackup>>
}

const { busy, needsReload, notice, commit, selectMonth } = useLedgerSession()
const { status: syncStatus } = useSyncSession()
const fileAction = ref<'open' | 'save' | null>(null)
const pending = shallowRef<SelectedBackup | null>(null)
const fileError = ref('')
const blocked = computed(() => busy.value || needsReload.value || fileAction.value !== null)
onBeforeRouteLeave(() => fileAction.value === null)

async function exportFile() {
  if (blocked.value) return
  fileAction.value = 'save'
  fileError.value = ''
  notice.value = ''
  try {
    const contents = await localBackup.exportBackup()
    if (await saveBackupFile(contents)) notice.value = t('settings.backup.saved')
  } catch (error) {
    fileError.value = displayError(error)
  } finally {
    fileAction.value = null
  }
}

async function chooseFile() {
  if (blocked.value) return
  fileAction.value = 'open'
  fileError.value = ''
  notice.value = ''
  try {
    const file = await chooseBackupFile()
    if (!file) return
    const counts = await localBackup.previewBackup(file.contents)
    pending.value = { ...file, counts }
  } catch (error) {
    pending.value = null
    fileError.value = displayError(error)
  } finally {
    fileAction.value = null
  }
}

function restoreBackup() {
  const file = pending.value
  if (!file || blocked.value || syncStatus.value?.bound) return
  return commit(() => localBackup.importBackup(file.contents), () => {
    pending.value = null
    selectMonth(currentMonth())
    notice.value = t('settings.backup.restored')
  })
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.backup.title')">
    <p v-if="fileError" class="settings-error" role="alert">{{ fileError }}</p>
    <section class="settings-sheet" aria-labelledby="backup-export-title">
      <h2 id="backup-export-title">{{ t('settings.backup.exportTitle') }}</h2>
      <p class="settings-muted">{{ t('settings.backup.exportHint') }}</p>
      <div class="settings-actions">
        <button type="button" class="settings-button primary" :disabled="blocked" @click="exportFile">
          <FileDown :size="17" aria-hidden="true" />{{ t('settings.backup.exportAction') }}
        </button>
      </div>
    </section>
    <section class="settings-sheet" aria-labelledby="backup-import-title">
      <h2 id="backup-import-title">{{ t('settings.backup.importTitle') }}</h2>
      <p v-if="syncStatus?.bound" class="settings-warning">{{ t('sync.maintenance') }}
        <RouterLink :to="{ name: 'settings-connections' }">{{ t('settings.connections.title') }}</RouterLink>
      </p>
      <p class="settings-muted">{{ t('settings.backup.importHint') }}</p>
      <div class="settings-actions">
        <button type="button" class="settings-button" :disabled="blocked || syncStatus?.bound" @click="chooseFile">
          <FileUp :size="17" aria-hidden="true" />{{ t('settings.backup.choose') }}
        </button>
      </div>
      <section v-if="pending" class="settings-preview" aria-labelledby="backup-preview-title">
        <h3 id="backup-preview-title">{{ t('settings.backup.preview') }}</h3>
        <p class="settings-file" role="status">{{ pending.name }}</p>
        <dl class="settings-counts">
          <div><dt>{{ t('settings.backup.platforms') }}</dt><dd>{{ pending.counts.platforms }}</dd></div>
          <div><dt>{{ t('settings.backup.entries') }}</dt><dd>{{ pending.counts.entries }}</dd></div>
          <div><dt>{{ t('settings.backup.overrides') }}</dt><dd>{{ pending.counts.overrides }}</dd></div>
        </dl>
        <p class="settings-warning">{{ t('settings.backup.replaceWarning') }}</p>
        <div class="settings-actions">
          <button type="button" class="settings-button" :disabled="blocked" @click="pending = null">{{ t('settings.action.cancel') }}</button>
          <button type="button" class="settings-button confirm-danger" :disabled="blocked || syncStatus?.bound" @click="restoreBackup">{{ t('settings.backup.confirm') }}</button>
        </div>
      </section>
    </section>
  </SettingsPageFrame>
</template>
