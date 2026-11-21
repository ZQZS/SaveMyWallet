<script setup lang="ts">
import { computed, ref, watchPostEffect } from 'vue'
import { PawPrint } from 'lucide-vue-next'
import { t } from '../../i18n'
import { usePets } from '../pets/usePets'
import { useReminders } from './useReminders'

const { activePopup, dismissPopup } = useReminders()
const { characters } = usePets()
const dialog = ref<HTMLDialogElement | null>(null)
const portrait = computed(() => {
  const pet = characters.value.find(character => character.id === activePopup.value?.petId)
  return pet?.greetAvatar || pet?.avatar
})

watchPostEffect(() => {
  if (!dialog.value) return
  if (activePopup.value && !dialog.value.open) dialog.value.showModal()
  else if (!activePopup.value && dialog.value.open) dialog.value.close()
})
</script>

<template>
  <dialog ref="dialog" class="pet-reminder-popup" aria-labelledby="pet-reminder-speaker" aria-describedby="pet-reminder-message"
    @cancel.prevent="dismissPopup()">
    <div v-if="activePopup" class="reminder-body">
      <span class="portrait" aria-hidden="true">
        <img v-if="portrait" :src="portrait" alt="" />
        <PawPrint v-else :size="30" />
      </span>
      <div class="reminder-content">
        <h2 id="pet-reminder-speaker">{{ activePopup.petName }}</h2>
        <p id="pet-reminder-message">{{ activePopup.message }}</p>
      </div>
      <button type="button" autofocus @click="dismissPopup()">{{ t('reminders.dismiss') }}</button>
    </div>
  </dialog>
</template>

<style scoped>
.pet-reminder-popup { width: min(27rem, calc(100% - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; overflow-y: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); color: var(--ink); }
.pet-reminder-popup::backdrop { background: var(--dialog-backdrop); }
.reminder-body { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: start; padding: clamp(16px, 4vw, 24px); }
.portrait { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 13px; background: var(--soft); color: var(--green); overflow: hidden; }
.portrait img { width: 100%; height: 100%; object-fit: contain; }
.reminder-content { min-width: 0; overflow-wrap: anywhere; }
.reminder-content h2 { margin: 0 0 5px; font-size: 1.04rem; }
.reminder-content p { margin: 0; white-space: pre-line; line-height: 1.6; }
button { grid-column: 1 / -1; justify-self: end; min-height: 44px; padding: 8px 18px; color: var(--on-accent); background: var(--accent-solid); border: 1px solid var(--accent-solid); border-radius: 9px; font-weight: 650; cursor: pointer; }
</style>
