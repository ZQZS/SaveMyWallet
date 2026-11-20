<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n'
import { Plus, Wallet } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import { usePlatformCreation } from './usePlatformCreation'
import '../../shared/styles/ledger-forms.css'

const { data: ledger, busy } = useLedgerSession()
const { name, errorKey, submit } = usePlatformCreation()
const counts = computed(() => {
  const byPlatform = new Map<string, number>()
  for (const entry of ledger.value?.entries ?? []) {
    byPlatform.set(entry.platformId, (byPlatform.get(entry.platformId) ?? 0) + 1)
  }
  return byPlatform
})
</script>

<template>
  <section v-if="ledger" class="ledger-editor" aria-labelledby="platform-heading">
    <header class="ledger-form-head"><h1 id="platform-heading">{{ t('forms.platforms') }}</h1></header>
    <form class="ledger-sheet" novalidate @submit.prevent="submit()">
      <div class="ledger-platform-add">
        <label class="ledger-field" for="platform-name"><span>{{ t('forms.newPlatformName') }}</span>
          <input id="platform-name" v-model="name" name="platformName" :placeholder="t('forms.platformHint')" required :disabled="busy" @input="errorKey = ''" />
        </label>
        <button type="submit" class="ledger-primary" :disabled="busy"><Plus :size="16" aria-hidden="true" />{{ t('forms.addPlatform') }}</button>
      </div>
      <p v-if="errorKey" class="ledger-error" role="alert">{{ t(errorKey) }}</p>
    </form>
    <section class="ledger-sheet ledger-platform-list" aria-labelledby="added-platforms">
      <div class="ledger-list-title"><h2 id="added-platforms">{{ t('forms.addedPlatforms') }}</h2><span>{{ t('forms.numberOfPlatforms', { count: ledger.platforms.length }) }}</span></div>
      <ul v-if="ledger.platforms.length">
        <li v-for="platform in ledger.platforms" :key="platform.id">
          <span class="ledger-platform-symbol" aria-hidden="true"><Wallet :size="17" /></span>
          <strong>{{ platform.name }}</strong><span>{{ t('forms.entryCount', { count: counts.get(platform.id) ?? 0 }) }}</span>
        </li>
      </ul>
      <p v-else class="ledger-hint">{{ t('forms.platformsEmpty') }}</p>
    </section>
  </section>
</template>
