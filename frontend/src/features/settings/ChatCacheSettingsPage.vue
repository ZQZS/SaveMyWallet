<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { t } from '../../i18n'
import { chatStorage } from '../pets/chatStorage'
import { usePets } from '../pets/usePets'
import SettingsPageFrame from './SettingsPageFrame.vue'

const { characters, storageError } = usePets()
const selection = ref('')
const confirmation = ref<{ petId: string | null | undefined; label: string } | null>(null)
const clearing = ref(false)
const failed = ref(false)
const cleared = ref('')
const picker = ref<HTMLSelectElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const reviewButton = ref<HTMLButtonElement | null>(null)

const characterOptions = computed(() => {
  const names = new Set<string>()
  const duplicates = new Set<string>()
  for (const pet of characters.value) {
    if (names.has(pet.name)) duplicates.add(pet.name)
    names.add(pet.name)
  }
  return characters.value.map(pet => ({ id: pet.id, label: duplicates.has(pet.name) ? pet.name + ' (' + pet.id + ')' : pet.name }))
})

async function review() {
  if (!selection.value || clearing.value || confirmation.value) return
  if (selection.value === 'all') confirmation.value = { petId: undefined, label: t('settings.chatCache.all') }
  else if (selection.value === 'general') confirmation.value = { petId: null, label: t('chat.noPersona') }
  else {
    const pet = characterOptions.value.find(option => option.id === selection.value)
    if (!pet) return
    confirmation.value = { petId: pet.id, label: pet.label }
  }
  cleared.value = ''
  failed.value = false
  await nextTick()
  cancelButton.value?.focus()
}

async function cancel() {
  if (clearing.value) return
  confirmation.value = null
  failed.value = false
  await nextTick()
  reviewButton.value?.focus()
}

async function clearConfirmed() {
  const target = confirmation.value
  if (!target || clearing.value) return
  clearing.value = true
  failed.value = false
  try {
    await chatStorage.clear(target.petId)
    cleared.value = target.label
    confirmation.value = null
    selection.value = ''
  } catch {
    failed.value = true
  } finally {
    clearing.value = false
  }
  await nextTick()
  if (failed.value) cancelButton.value?.focus()
  else picker.value?.focus()
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.chatCache.title')">
    <section class="settings-sheet" aria-labelledby="chat-cache-label">
      <label id="chat-cache-label" for="chat-cache-target" class="cache-label">{{ t('settings.chatCache.scope') }}</label>
      <select id="chat-cache-target" ref="picker" v-model="selection" name="chatCacheTarget"
        :disabled="!!confirmation" @change="cleared = ''">
        <option disabled value="">{{ t('settings.chatCache.choose') }}</option>
        <option value="all">{{ t('settings.chatCache.all') }}</option>
        <option value="general">{{ t('chat.noPersona') }}</option>
        <optgroup :label="t('settings.chatCache.characters')">
          <option v-for="pet in characterOptions" :key="pet.id" :value="pet.id">{{ pet.label }}</option>
        </optgroup>
      </select>
      <p v-if="storageError" class="settings-muted" role="status">{{ t('pets.picker.storageUnavailable') }}</p>
      <div v-if="!confirmation" class="settings-actions">
        <button ref="reviewButton" type="button" name="reviewChatCacheClear" class="settings-button danger"
          :disabled="!selection" @click="review">{{ t('settings.chatCache.review') }}</button>
      </div>
      <div v-else class="settings-preview" role="group" aria-labelledby="chat-cache-confirmation">
        <p id="chat-cache-confirmation" class="settings-warning">
          {{ confirmation.petId === undefined ? t('settings.chatCache.confirmAll') : confirmation.petId === null
            ? t('settings.chatCache.confirmGeneral') : t('settings.chatCache.confirmPet', { name: confirmation.label }) }}
        </p>
        <div class="settings-actions">
          <button ref="cancelButton" type="button" name="cancelChatCacheClear" class="settings-button"
            :disabled="clearing" @click="cancel">{{ t('settings.action.cancel') }}</button>
          <button type="button" name="confirmChatCacheClear" class="settings-button confirm-danger"
            :disabled="clearing" @click="clearConfirmed">{{ t('settings.chatCache.confirm') }}</button>
        </div>
      </div>
      <p v-if="failed" class="settings-error" role="alert">{{ t('settings.chatCache.failed') }}</p>
      <p v-if="cleared" class="settings-muted" role="status">{{ t('settings.chatCache.done', { name: cleared }) }}</p>
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.cache-label { font-weight: 650; }
.settings-sheet select { min-width: 0; width: 100%; max-width: 28rem; min-height: 44px; padding: 8px 10px; background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; font: inherit; text-overflow: ellipsis; }
.settings-warning, .settings-muted { overflow-wrap: anywhere; }
</style>
