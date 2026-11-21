<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../i18n'
import PetPicker from './PetPicker.vue'

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let opener: HTMLElement | null = null
onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <dialog ref="dialog" class="pet-dialog" aria-labelledby="pet-dialog-title" @close="emit('close')">
    <header>
      <h2 id="pet-dialog-title">{{ t('pets.picker.title') }}</h2>
      <button type="button" autofocus :aria-label="t('pets.picker.close')" @click="dialog?.close()">
        <X :size="20" aria-hidden="true" />
      </button>
    </header>
    <PetPicker @select="dialog?.close()" />
  </dialog>
</template>

<style scoped>
.pet-dialog {
  width: min(37rem, calc(100% - 2rem)); max-height: calc(100% - 2rem); margin: auto; padding: 0 20px 20px;
  overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line); border-radius: 16px;
  background: var(--surface); color: var(--ink);
}
.pet-dialog::backdrop { background: var(--dialog-backdrop); }
.pet-dialog header {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 10px 0; background: var(--surface);
}
.pet-dialog h2 { font-size: 1.12rem; }
.pet-dialog header button { display: grid; place-items: center; width: 44px; height: 44px; color: var(--sub); background: transparent; border: 0; border-radius: 8px; }
@media (max-width: 440px) {
  .pet-dialog { width: calc(100% - 16px); padding-inline: 12px; }
}
</style>
