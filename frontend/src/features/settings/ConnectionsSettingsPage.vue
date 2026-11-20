<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { useLedgerSession } from '../../app/ledgerSession'
import { useSyncSession } from '../../app/syncSession'
import { displayError, t } from '../../i18n'
import { saveBackupFile } from './backupFiles'
import type { ConflictChoice, SyncPreview } from './sync/syncTypes'
import SyncConflictCard from './SyncConflictCard.vue'
import SettingsPageFrame from './SettingsPageFrame.vue'

const ledger = useLedgerSession()
const sync = useSyncSession()
const { status, action, error } = sync
const url = ref('')
const token = ref('')
const preview = shallowRef<SyncPreview | null>(null)
const changingToken = ref(false)
const askingDisconnect = ref(false)
const interacting = ref(false)
const message = ref('')
const fileError = ref('')
const blocked = computed(() => interacting.value || sync.busy.value || ledger.busy.value || ledger.needsReload.value)
onBeforeRouteLeave(() => !interacting.value)
onMounted(() => { void sync.load() })
watch([url, token], () => { preview.value = null }, { flush: 'sync' })

async function interact(work: () => Promise<void>) {
  if (blocked.value) return
  interacting.value = true
  fileError.value = ''
  message.value = ''
  try { await work() } catch (cause) { fileError.value = displayError(cause) }
  finally { interacting.value = false }
}

async function run() {
  const result = await sync.run()
  if (result) message.value = result.conflicts.length ? 'sync.review' : 'sync.done'
}
function checkPreview() {
  return interact(async () => { preview.value = await sync.preview(url.value.trim(), token.value) ?? null })
}
function connect() {
  return interact(async () => {
    const checked = preview.value
    if (!checked) return
    preview.value = null
    if (await sync.bind(url.value.trim(), token.value, checked)) {
      token.value = ''
      await run()
    }
  })
}
function unlock() {
  return interact(async () => {
    if (await sync.authenticate(token.value)) {
      token.value = ''
      changingToken.value = false
      await run()
    }
  })
}
function unlink() {
  return interact(async () => {
    if (await sync.disconnect()) {
      askingDisconnect.value = false
      changingToken.value = false
      token.value = ''
      message.value = 'sync.disconnected'
    }
  })
}
function resolve(operationId: string, choice: ConflictChoice) {
  return interact(async () => {
    if (await sync.resolve(operationId, choice)) {
      await run()
    }
  })
}
function exportPrevious() {
  return interact(async () => {
    const contents = await invoke<string | null>('sync_previous_backup')
    if (!contents) message.value = 'sync.noPrevious'
    else if (await saveBackupFile(contents)) message.value = 'settings.backup.saved'
  })
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.connections.title')">
    <p v-if="fileError || error" role="alert" class="settings-error">{{ fileError || error }}</p>
    <p v-if="message" role="status" class="settings-muted">{{ t(message) }}</p>
    <section v-if="!status" class="settings-sheet">
      <p v-if="!error">{{ t('sync.loading') }}</p>
      <button v-else type="button" class="settings-button" :disabled="blocked" @click="sync.load">{{ t('app.retry') }}</button>
    </section>
    <section v-else-if="!status.bound" class="settings-sheet" aria-labelledby="sync-connect">
      <h2 id="sync-connect">{{ t('sync.connect') }}</h2>
      <form class="settings-reset-form" @submit.prevent="checkPreview">
        <label>{{ t('sync.address') }}
          <input v-model="url" name="syncUrl" inputmode="url" type="url" autocomplete="off" placeholder="https://wallet.example.com"
            required :disabled="blocked" spellcheck="false" aria-describedby="sync-url-hint" />
        </label>
        <p id="sync-url-hint" class="settings-muted">{{ t('sync.addressHint') }}</p>
        <label>{{ t('sync.token') }}
          <input v-model="token" name="syncToken" type="password" autocomplete="off" required :disabled="blocked" />
        </label>
        <p class="settings-muted">{{ t('sync.tokenHint') }}</p>
        <div class="settings-actions">
          <button class="settings-button" type="submit" :disabled="blocked || !url.trim() || !token">{{ t('sync.preview') }}</button>
        </div>
      </form>
      <section v-if="preview" class="settings-preview" aria-labelledby="sync-preview">
        <h3 id="sync-preview">{{ t('sync.previewTitle') }}</h3>
        <dl class="settings-counts">
          <div><dt>{{ t('sync.ledger') }}</dt><dd>{{ preview.ledgerId }}</dd></div>
          <div><dt>{{ t('sync.server') }}</dt><dd>{{ t('sync.counts', { platforms: preview.platforms, entries: preview.entries }) }}</dd></div>
          <div v-if="ledger.data.value"><dt>{{ t('sync.device') }}</dt>
            <dd>{{ t('sync.counts', { platforms: ledger.data.value.platforms.length, entries: ledger.data.value.entries.length }) }}</dd>
          </div>
        </dl>
        <p :class="preview.empty ? 'settings-muted' : 'settings-warning'">{{ t(preview.empty ? 'sync.emptyCloud' : 'sync.existingCloud') }}</p>
        <div class="settings-actions">
          <button class="settings-button" type="button" :disabled="blocked" @click="preview = null">{{ t('settings.action.cancel') }}</button>
          <button class="settings-button" :class="preview.empty ? 'primary' : 'confirm-danger'" type="button" :disabled="blocked" @click="connect">
            {{ t(preview.empty ? 'sync.seed' : 'sync.join') }}
          </button>
        </div>
      </section>
    </section>
    <template v-else>
      <section class="settings-sheet" aria-labelledby="sync-bound">
        <h2 id="sync-bound">{{ t('sync.bound') }}</h2>
        <dl class="settings-counts">
          <div><dt>{{ t('sync.ledger') }}</dt><dd>{{ status.ledgerId }}</dd></div>
          <div><dt>{{ t('sync.address') }}</dt><dd>{{ status.url }}</dd></div>
          <div><dt>{{ t('sync.pending') }}</dt><dd>{{ status.pending }}</dd></div>
          <div><dt>{{ t('sync.conflicts') }}</dt><dd>{{ status.conflicts.length }}</dd></div>
        </dl>
        <p class="settings-muted">{{ t(status.authenticated ? 'sync.auto' : 'sync.locked') }}</p>
        <form v-if="!status.authenticated || changingToken" class="settings-reset-form" @submit.prevent="unlock">
          <label>{{ t('sync.token') }}
            <input v-model="token" name="syncToken" type="password" autocomplete="off" required :disabled="blocked" />
          </label>
          <div class="settings-actions">
            <button type="submit" class="settings-button primary" :disabled="blocked || !token">{{ t('sync.unlock') }}</button>
            <button v-if="status.authenticated" type="button" class="settings-button" :disabled="blocked" @click="changingToken = false; token = ''">{{ t('settings.action.cancel') }}</button>
          </div>
        </form>
        <div v-else class="settings-actions">
          <button type="button" class="settings-button primary" :disabled="blocked" @click="interact(run)">{{ t(action === 'sync_run' ? 'sync.working' : 'sync.run') }}</button>
          <button type="button" class="settings-button" :disabled="blocked" @click="changingToken = true">{{ t('sync.changeToken') }}</button>
        </div>
      </section>
      <SyncConflictCard v-for="conflict in status.conflicts" :key="conflict.operationId" :conflict="conflict"
        :disabled="blocked || !status.authenticated" @resolve="resolve(conflict.operationId, $event)" />
    </template>
    <section v-if="status?.bound || status?.hasPreviousBackup" class="settings-sheet">
      <div class="settings-actions">
        <button v-if="status.hasPreviousBackup" type="button" class="settings-button" :disabled="blocked" @click="exportPrevious">{{ t('sync.previous') }}</button>
        <button v-if="status.bound && !askingDisconnect" type="button" class="settings-button danger" :disabled="blocked" @click="askingDisconnect = true">{{ t('sync.disconnect') }}</button>
      </div>
      <template v-if="status.bound && askingDisconnect">
        <p class="settings-warning">{{ t('sync.disconnectWarning') }}</p>
        <div class="settings-actions">
          <button type="button" class="settings-button" :disabled="blocked" @click="askingDisconnect = false">{{ t('settings.action.cancel') }}</button>
          <button type="button" class="settings-button confirm-danger" :disabled="blocked" @click="unlink">{{ t('sync.confirmDisconnect') }}</button>
        </div>
      </template>
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.settings-counts div { max-width: 100%; overflow-wrap: anywhere; }
</style>
