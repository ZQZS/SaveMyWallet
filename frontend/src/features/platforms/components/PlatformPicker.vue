<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import { t } from '../../../i18n'
import { Plus } from 'lucide-vue-next'
import type { Platform } from '../../../domain/ledger'
import { usePlatformCreation } from '../usePlatformCreation'

defineProps<{ platforms: Platform[]; busy: boolean; locked: boolean }>()
const selectedId = defineModel<string>({ required: true })
const editing = defineModel<boolean>('editing', { required: true })
const { name, errorKey, reset, submit } = usePlatformCreation()
const input = ref<HTMLInputElement | null>(null)
const select = ref<HTMLSelectElement | null>(null)
const selectId = useId()
const inputId = useId()

function open() {
  reset()
  editing.value = true
  nextTick(() => input.value?.focus())
}

function close() {
  reset()
  editing.value = false
  nextTick(() => select.value?.focus())
}

function saveAndSelect() {
  return submit(id => {
    selectedId.value = id
    close()
  })
}

function onEnter(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  saveAndSelect()
}
</script>

<template>
  <div class="ledger-field">
    <div class="ledger-field-title">
      <label :for="selectId">{{ t('forms.platform') }}</label>
      <button v-if="!locked && !editing" type="button" class="ledger-text-btn" :disabled="busy" @click="open">
        <Plus :size="14" aria-hidden="true" />{{ t('forms.newPlatform') }}
      </button>
    </div>
    <select :id="selectId" ref="select" v-model="selectedId" name="platform" :disabled="locked || busy || editing" required>
      <option v-if="!platforms.length" value="">{{ t('forms.noPlatform') }}</option>
      <option v-else-if="!selectedId" disabled value="">{{ t('billImage.choosePlatform') }}</option>
      <option v-for="platform in platforms" :key="platform.id" :value="platform.id">{{ platform.name }}</option>
    </select>
  </div>
  <div v-if="editing" class="ledger-inline-platform ledger-wide">
    <label class="ledger-field" :for="inputId">{{ t('forms.newPlatformName') }}</label>
    <input :id="inputId" ref="input" v-model="name" class="ledger-input" :disabled="busy" :placeholder="t('forms.platformShortHint')"
      @keydown.enter="onEnter" @input="errorKey = ''" />
    <p v-if="errorKey" class="ledger-error" role="alert">{{ t(errorKey) }}</p>
    <div class="ledger-inline-actions">
      <button type="button" class="ledger-secondary" :disabled="busy" @click="close">{{ t('forms.cancelNewPlatform') }}</button>
      <button type="button" class="ledger-primary" :disabled="busy" @click="saveAndSelect">{{ t('forms.saveAndSelect') }}</button>
    </div>
  </div>
</template>
