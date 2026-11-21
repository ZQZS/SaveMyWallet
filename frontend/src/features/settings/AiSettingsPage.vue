<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { displayError, t } from '../../i18n'
import { getAiKeyStatus, isNativeAiAvailable, removeAiKey, saveAiKey, testAiConnection } from '../../integrations/ai/deepseek'
import SettingsPageFrame from './SettingsPageFrame.vue'

const native = isNativeAiAvailable()
const configured = ref<boolean | null>(null)
const action = ref<'' | 'load' | 'save' | 'test' | 'remove'>('')
const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)
const message = ref('')
const error = ref('')

async function perform(operation: 'load' | 'save' | 'test' | 'remove', work: () => Promise<void>) {
  if (action.value) return
  action.value = operation
  message.value = ''
  error.value = ''
  try {
    await work()
  } catch (cause) {
    error.value = displayError(cause)
  } finally {
    action.value = ''
  }
}

function load() {
  return perform('load', async () => { configured.value = await getAiKeyStatus() })
}

async function edit() {
  message.value = ''
  error.value = ''
  editing.value = true
  await nextTick()
  input.value?.focus()
}

function save() {
  if (!draft.value.trim()) return
  return perform('save', async () => {
    const key = draft.value.trim()
    draft.value = ''
    await saveAiKey(key)
    configured.value = true
    editing.value = false
    message.value = 'aiSettings.saved'
  })
}

function test() {
  return perform('test', async () => {
    await testAiConnection()
    message.value = 'aiSettings.verified'
  })
}

function remove() {
  return perform('remove', async () => {
    await removeAiKey()
    configured.value = false
    message.value = 'aiSettings.removed'
  })
}

onMounted(() => { if (native) void load() })
onBeforeRouteLeave(() => action.value !== 'save' && action.value !== 'remove')
</script>

<template>
  <SettingsPageFrame :title="t('settings.ai.title')">
    <section class="settings-sheet" aria-labelledby="deepseek-title">
      <h2 id="deepseek-title">DeepSeek</h2>
      <p v-if="!native" class="settings-muted">{{ t('aiSettings.native') }}</p>
      <template v-else>
        <p id="key-storage" class="settings-muted">{{ t('aiSettings.storage') }}</p>
        <p v-if="action === 'load'" role="status">{{ t('aiSettings.loading') }}</p>
        <div v-else-if="configured === null" class="settings-actions">
          <button type="button" class="settings-button" :disabled="!!action" @click="load">{{ t('app.retry') }}</button>
          <button type="button" class="settings-button danger" :disabled="!!action" @click="remove">{{ t('aiSettings.remove') }}</button>
        </div>
        <form v-else-if="!configured || editing" class="settings-reset-form" @submit.prevent="save">
          <label>
            {{ t(editing ? 'aiSettings.newKey' : 'aiSettings.key') }}
            <input ref="input" v-model="draft" type="password" required maxlength="2560" autocomplete="off" autocapitalize="none"
              spellcheck="false" aria-describedby="key-storage" :disabled="!!action" />
          </label>
          <div class="settings-actions">
            <button type="submit" class="settings-button primary" :disabled="!!action || !draft.trim()">
              {{ t(editing ? 'aiSettings.apply' : 'aiSettings.save') }}
            </button>
            <button v-if="editing" type="button" class="settings-button" :disabled="!!action"
              @click="draft = ''; editing = false; error = ''">{{ t('settings.action.cancel') }}</button>
          </div>
        </form>
        <template v-else>
          <p v-if="!message">{{ t('aiSettings.configured') }}</p>
          <div class="settings-actions">
            <button type="button" class="settings-button primary" :disabled="!!action" @click="test">
              {{ t(action === 'test' ? 'aiSettings.testing' : 'aiSettings.test') }}
            </button>
            <button type="button" class="settings-button" :disabled="!!action" @click="edit">{{ t('aiSettings.replace') }}</button>
            <button type="button" class="settings-button danger" :disabled="!!action" @click="remove">{{ t('aiSettings.remove') }}</button>
          </div>
        </template>
        <p v-if="message" role="status" class="settings-muted">{{ t(message) }}</p>
        <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
      </template>
    </section>
    <section class="settings-sheet" aria-labelledby="ai-requests">
      <h2 id="ai-requests">{{ t('aiSettings.requests') }}</h2>
      <ul class="ai-requests settings-muted">
        <li>{{ t('aiSettings.reminder') }}</li>
        <li>{{ t('aiSettings.image') }}</li>
        <li>{{ t('aiSettings.scenario') }}</li>
      </ul>
      <p class="settings-muted">{{ t('aiSettings.billing') }}</p>
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.ai-requests { margin: 0; padding-inline-start: 1.25rem; }
.ai-requests li + li { margin-top: .4rem; }
</style>
