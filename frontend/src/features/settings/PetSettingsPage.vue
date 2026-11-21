<script setup lang="ts">
import { t } from '../../i18n'
import { usePets } from '../pets/usePets'
import PetPicker from '../pets/PetPicker.vue'
import SettingsPageFrame from './SettingsPageFrame.vue'

const { enabled, setEnabled } = usePets()
</script>

<template>
  <SettingsPageFrame :title="t('settings.pets.title')">
    <div class="settings-sheet visibility-sheet">
      <label class="visibility-control">
        <span>{{ t('pets.picker.enable') }}</span>
        <input type="checkbox" role="switch" :checked="enabled" @change="setEnabled(($event.currentTarget as HTMLInputElement).checked)" />
      </label>
    </div>
    <section class="settings-sheet" aria-labelledby="pet-library-title">
      <h2 id="pet-library-title">{{ t('pets.picker.title') }}</h2>
      <PetPicker />
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.visibility-sheet { padding-block: 10px; }
.visibility-control { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-weight: 650; cursor: pointer; }
.visibility-control input { flex: none; appearance: none; position: relative; width: 44px; height: 26px; margin: 0; border: 1px solid var(--sub); border-radius: 15px; background: var(--line); cursor: pointer; }
.visibility-control input::after { content: ''; display: block; width: 18px; height: 18px; margin: 3px; border-radius: 50%; background: var(--sub); }
.visibility-control input:checked { background: var(--accent-solid); border-color: var(--accent-solid); }
.visibility-control input:checked::after { transform: translateX(18px); background: var(--on-accent); }
@media (forced-colors: active) {
  .visibility-control input { appearance: auto; width: 20px; height: 20px; }
  .visibility-control input::after { display: none; }
}
</style>
