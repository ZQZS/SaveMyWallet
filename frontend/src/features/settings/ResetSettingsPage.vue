<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLedgerSession } from '../../app/ledgerSession'
import { useSyncSession } from '../../app/syncSession'
import { currentMonth } from '../../domain/ledger'
import { t } from '../../i18n'
import { localBackup } from './backupService'
import SettingsPageFrame from './SettingsPageFrame.vue'

const { busy, needsReload, notice, commit, selectMonth } = useLedgerSession()
const { status: syncStatus } = useSyncSession()
const router = useRouter()
const confirming = ref(false)
const phrase = ref('')
const confirmationInput = ref<HTMLInputElement | null>(null)
const resetButton = ref<HTMLButtonElement | null>(null)
const requiredPhrase = '重置'
const canReset = computed(() => confirming.value && phrase.value === requiredPhrase && !busy.value && !needsReload.value && !syncStatus.value?.bound)

async function askForConfirmation() {
  phrase.value = ''
  confirming.value = true
  notice.value = ''
  await nextTick()
  confirmationInput.value?.focus()
}

async function closeConfirmation() {
  confirming.value = false
  phrase.value = ''
  await nextTick()
  resetButton.value?.focus()
}

function resetLedger() {
  if (!canReset.value) return
  const confirmation = phrase.value
  return commit(() => localBackup.resetLedger(confirmation), () => {
    selectMonth(currentMonth())
    notice.value = t('settings.reset.done')
    void closeConfirmation()
  })
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.reset.title')">
    <section class="settings-sheet" aria-labelledby="reset-local-title">
      <h2 id="reset-local-title">{{ t('settings.reset.scopeTitle') }}</h2>
      <p class="settings-muted">{{ t('settings.reset.scope') }}</p>
      <p class="settings-muted">{{ t('settings.reset.defaults') }}</p>
      <p class="settings-warning">{{ t('settings.reset.warning') }}</p>
      <p v-if="syncStatus?.bound" class="settings-warning">{{ t('sync.maintenance') }}
        <RouterLink :to="{ name: 'settings-connections' }">{{ t('settings.connections.title') }}</RouterLink>
      </p>
      <div v-if="!confirming" class="settings-actions">
        <button type="button" class="settings-button" :disabled="busy" @click="router.push({ name: 'settings-backup' })">{{ t('settings.reset.backup') }}</button>
        <button ref="resetButton" type="button" class="settings-button danger" :disabled="busy || syncStatus?.bound" @click="askForConfirmation">{{ t('settings.reset.start') }}</button>
      </div>
      <form v-else class="settings-reset-form" @submit.prevent="resetLedger">
        <label>
          {{ t('settings.reset.type', { phrase: requiredPhrase }) }}
          <input ref="confirmationInput" v-model="phrase" name="confirmation" type="text" autocomplete="off"
            :spellcheck="false" :disabled="busy" aria-describedby="reset-phrase-hint" />
        </label>
        <p id="reset-phrase-hint" class="settings-muted">{{ t('settings.reset.exact') }}</p>
        <div class="settings-actions">
          <button type="button" class="settings-button" :disabled="busy" @click="closeConfirmation">{{ t('settings.action.cancel') }}</button>
          <button type="submit" class="settings-button confirm-danger" :disabled="!canReset">{{ t('settings.reset.confirm') }}</button>
        </div>
      </form>
    </section>
  </SettingsPageFrame>
</template>
