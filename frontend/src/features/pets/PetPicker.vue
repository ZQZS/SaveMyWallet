<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { Check, FileUp, Trash2 } from 'lucide-vue-next'
import { t } from '../../i18n'
import { usePets } from './usePets'

const emit = defineEmits<{ select: [] }>()
const { activePet, characters, ready, storageError, preferenceError, selectPet, importPet, removePet } = usePets()
const fileInput = ref<HTMLInputElement | null>(null)
const importButton = ref<HTMLButtonElement | null>(null)
const pending = ref(false)
const expandedId = ref('')
const removeId = ref('')
const errorKey = ref('')
const announcement = ref<{ key: string; name: string } | null>(null)
const previewLimit = 140

function excerpt(text: string, expanded: boolean) {
  if (expanded || text.length <= previewLimit) return text
  return text.slice(0, previewLimit).replace(/[\uD800-\uDBFF]$/, '') + '…'
}

function showError(error: unknown, fallback: string) {
  errorKey.value = error instanceof Error && error.message.startsWith('pets.import.') ? error.message : fallback
}

function select(id: string) {
  errorKey.value = ''
  selectPet(id)
  announcement.value = { key: 'pets.picker.selectedNotice', name: activePet.value.name }
  if (!preferenceError.value) emit('select')
}

async function handleFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || pending.value) return
  pending.value = true
  errorKey.value = ''
  announcement.value = null
  try {
    await importPet(file)
    removeId.value = ''
    announcement.value = { key: 'pets.picker.importedNotice', name: activePet.value.name }
  } catch (error) {
    showError(error, 'pets.import.invalid')
  } finally {
    pending.value = false
  }
}

async function confirmRemoval(id: string, name: string) {
  if (removeId.value !== id || pending.value) return
  pending.value = true
  errorKey.value = ''
  announcement.value = null
  try {
    await removePet(id)
    removeId.value = ''
    announcement.value = { key: 'pets.picker.removedNotice', name }
  } catch (error) {
    showError(error, 'pets.import.storage')
  } finally {
    pending.value = false
  }
  await nextTick()
  importButton.value?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="pet-picker">
    <div class="import-row">
      <input ref="fileInput" hidden type="file" accept=".json,.png,application/json,image/png" @change="handleFile" />
      <button ref="importButton" type="button" class="import-button" :disabled="!ready || pending" @click="fileInput?.click()">
        <FileUp :size="17" aria-hidden="true" />{{ t('pets.picker.import') }}
      </button>
      <span class="format-hint">{{ t('pets.picker.formats') }}</span>
    </div>
    <p v-if="storageError" class="error" role="alert">{{ t('pets.picker.storageUnavailable') }}</p>
    <p v-if="preferenceError" class="error" role="alert">{{ t('pets.picker.preferenceError') }}</p>
    <p v-if="errorKey" class="error" role="alert">{{ t(errorKey) }}</p>
    <p v-if="pending || !ready || announcement" class="status" role="status">
      {{ pending ? t('pets.picker.working') : !ready ? t('pets.picker.loading') : announcement && t(announcement.key, { name: announcement.name }) }}
    </p>
    <ul v-if="ready" class="pet-list">
      <li v-for="pet in characters" :key="pet.id" class="pet-card" :class="{ current: activePet.id === pet.id }">
        <span class="avatar" aria-hidden="true">
          <img v-if="pet.avatar" :src="pet.avatar" alt="" loading="lazy" />
          <strong v-else>{{ Array.from(pet.name)[0] }}</strong>
        </span>
        <div class="pet-info">
          <h3>{{ pet.name }}</h3>
          <p v-if="pet.description" class="description">{{ excerpt(pet.description, expandedId === pet.id) }}</p>
          <blockquote v-if="pet.preview">{{ excerpt(pet.preview, expandedId === pet.id) }}</blockquote>
          <button v-if="pet.description.length > previewLimit || pet.preview.length > previewLimit"
            type="button" class="text-button" :aria-expanded="expandedId === pet.id" @click="expandedId = expandedId === pet.id ? '' : pet.id">
            {{ t(expandedId === pet.id ? 'pets.picker.less' : 'pets.picker.more') }}
          </button>
        </div>
        <div class="card-actions">
          <span v-if="activePet.id === pet.id" class="current-label">
            <Check :size="15" aria-hidden="true" />{{ t('pets.picker.current') }}
          </span>
          <button v-else class="select-button" type="button" :disabled="pending" :aria-label="t('pets.picker.selectName', { name: pet.name })" @click="select(pet.id)">
            {{ t('pets.picker.select') }}
          </button>
          <button v-if="pet.imported" type="button" class="remove-button" :disabled="pending"
            :aria-label="t('pets.picker.removeName', { name: pet.name })" :aria-expanded="removeId === pet.id"
            @click="removeId = removeId === pet.id ? '' : pet.id">
            <Trash2 :size="16" aria-hidden="true" />
          </button>
        </div>
        <div v-if="removeId === pet.id" class="remove-confirm">
          <p>{{ t('pets.picker.removeQuestion', { name: pet.name }) }}</p>
          <div>
            <button class="select-button" type="button" :disabled="pending" @click="removeId = ''">{{ t('settings.action.cancel') }}</button>
            <button class="confirm-button" type="button" :disabled="pending" @click="confirmRemoval(pet.id, pet.name)">{{ t('pets.picker.confirmRemove') }}</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pet-picker { min-width: 0; display: grid; gap: 12px; overflow-wrap: anywhere; }
.pet-picker button { min-height: 44px; font-size: .86rem; font-weight: 600; border-radius: 9px; }
.pet-picker button:disabled { opacity: .55; }
.import-row, .card-actions, .remove-confirm > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.import-button, .select-button, .confirm-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 6px 12px; border: 1px solid var(--line); background: var(--surface); color: var(--green); }
.format-hint, .description, .status { color: var(--sub); font-size: .85rem; line-height: 1.5; }
.error { color: var(--danger-ink); font-size: .9rem; }
.pet-list { display: grid; gap: 9px; list-style: none; padding: 0; margin: 0; }
.pet-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 10px 14px; padding: 13px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.pet-card.current { border-color: var(--green); }
.avatar { display: grid; place-items: center; width: 60px; aspect-ratio: 1; background: var(--soft); color: var(--green); border-radius: 11px; overflow: hidden; }
.avatar img { display: block; width: 100%; height: 100%; object-fit: contain; }
.pet-info h3 { margin: 0; font-size: 1rem; line-height: 1.4; }
.description { margin-top: 3px; }
.pet-info blockquote { margin: 7px 0 0; padding-inline-start: 9px; border-inline-start: 2px solid var(--line); color: var(--ink); font-size: .88rem; line-height: 1.55; }
.text-button, .remove-button { color: var(--green); border: 0; background: transparent; }
.text-button { padding-inline: 0; text-decoration: underline; text-underline-offset: 3px; }
.current-label { display: inline-flex; align-items: center; gap: 3px; color: var(--green); font-size: .83rem; font-weight: 650; }
.remove-button { display: grid; place-items: center; width: 44px; color: var(--sub); }
.remove-confirm { grid-column: 1 / -1; display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; color: var(--ink); font-size: .9rem; }
.confirm-button { background: var(--danger-solid); color: var(--on-danger); border-color: var(--danger-solid); }
@media (max-width: 550px) {
  .pet-card { grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; padding: 10px; }
  .avatar { width: 46px; }
  .card-actions { grid-column: 2; }
}
</style>
