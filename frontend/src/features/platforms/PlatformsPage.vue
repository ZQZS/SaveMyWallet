<script setup lang="ts">
import { t } from '../../i18n'
import { ChevronRight, Plus, Wallet } from 'lucide-vue-next'
import { useLedgerSession } from '../../app/ledgerSession'
import PlatformSummary from './components/PlatformSummary.vue'
import { usePlatformCreation } from './usePlatformCreation'
import '../../shared/styles/ledger-forms.css'

const { data: ledger, platformSummaries, busy } = useLedgerSession()
const { name, errorKey, submit } = usePlatformCreation()
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
      <div class="ledger-list-title"><h2 id="added-platforms">{{ t('forms.allMonthsSummary') }}</h2><span>{{ t('forms.numberOfPlatforms', { count: ledger.platforms.length }) }}</span></div>
      <ul v-if="platformSummaries?.size">
        <li v-for="summary in platformSummaries.values()" :key="summary.platform.id">
          <RouterLink class="platform-link" :to="{ name: 'platform-details', params: { id: summary.platform.id } }">
            <span class="ledger-platform-symbol" aria-hidden="true"><Wallet :size="17" /></span>
            <h3>{{ summary.platform.name }}</h3>
            <ChevronRight :size="16" aria-hidden="true" />
          </RouterLink>
          <PlatformSummary :summary="summary" />
        </li>
      </ul>
      <p v-else class="ledger-hint">{{ t('forms.platformsEmpty') }}</p>
    </section>
  </section>
</template>
