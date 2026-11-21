<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Plus, Trash2 } from 'lucide-vue-next'
import { t } from '../../i18n'
import SettingsPageFrame from '../settings/SettingsPageFrame.vue'
import { presetStyle, themeBases, useAppearance, type ThemeStyle } from './appearance'
import ThemePreview from './ThemePreview.vue'
import ThemeStyleControls from './ThemeStyleControls.vue'

const { style, activeId, customThemes, selectTheme, updateStyle, removeTheme } = useAppearance()
const presets = themeBases.map(base => ({ id: base, style: presetStyle(base) }))
const storedStyle = computed(() => customThemes.value.find(theme => theme.id === activeId.value)?.style ?? presetStyle(style.value.base))
const modified = computed(() => {
  const original = storedStyle.value
  return original.accent !== style.value.accent || original.background !== style.value.background ||
    (style.value.background === 'photo' && original.photo !== style.value.photo)
})
const removing = ref('')
const errorSection = ref('')

function applyTheme(id: string) {
  errorSection.value = selectTheme(id) ? '' : 'themes'
  removing.value = ''
}

function applyStyle(next: ThemeStyle, section: 'accent' | 'background') {
  const patch = section === 'accent' ? { accent: next.accent } : { background: next.background, photo: next.photo }
  errorSection.value = updateStyle(patch) ? '' : section
}

function deleteTheme(id: string) {
  if (removeTheme(id)) {
    removing.value = ''
    errorSection.value = ''
  } else errorSection.value = 'themes'
}
</script>

<template>
  <SettingsPageFrame :title="t('settings.appearance.title')">
    <ThemePreview :style-config="style" />
    <section class="settings-sheet" aria-labelledby="themes-heading">
      <header class="section-heading">
        <h2 id="themes-heading">{{ t('appearance.themes') }}</h2>
        <RouterLink class="create-theme" :to="{ name: 'settings-theme-create' }"><Plus :size="16" aria-hidden="true" />{{ t('appearance.create') }}</RouterLink>
      </header>
      <div class="preset-list" role="group" :aria-label="t('appearance.themes')">
        <button v-for="preset in presets" :key="preset.id" type="button" class="preset-card" :data-theme-id="preset.id"
          :aria-pressed="activeId === preset.id" @click="applyTheme(preset.id)">
          <ThemePreview :style-config="preset.style" compact />
          <span class="theme-name">{{ t('appearance.base.' + preset.id) }}<Check v-if="activeId === preset.id" :size="16" aria-hidden="true" /></span>
        </button>
      </div>
      <template v-if="customThemes.length">
        <h3 class="custom-heading">{{ t('appearance.myThemes') }}</h3>
        <ul class="custom-list">
          <li v-for="theme in customThemes" :key="theme.id">
            <template v-if="removing !== theme.id">
              <button type="button" class="custom-theme" :data-theme-id="theme.id" :aria-pressed="activeId === theme.id" @click="applyTheme(theme.id)">
                <span class="custom-color" :style="{ backgroundColor: theme.style.accent }" aria-hidden="true"></span>
                {{ theme.name }}<Check v-if="activeId === theme.id" :size="16" aria-hidden="true" />
              </button>
              <button type="button" class="remove-theme" :aria-label="t('appearance.remove', { name: theme.name })" @click="removing = theme.id">
                <Trash2 :size="16" aria-hidden="true" />
              </button>
            </template>
            <template v-else>
              <span class="remove-prompt">{{ t('appearance.askRemove', { name: theme.name }) }}</span>
              <button type="button" class="settings-button" @click="removing = ''">{{ t('settings.action.cancel') }}</button>
              <button type="button" class="settings-button danger" @click="deleteTheme(theme.id)">{{ t('appearance.delete') }}</button>
            </template>
          </li>
        </ul>
      </template>
      <p v-if="modified" class="settings-muted">{{ t('appearance.modified') }}</p>
      <p v-if="errorSection === 'themes'" class="settings-error" role="alert">{{ t('appearance.storageError') }}</p>
    </section>
    <section class="settings-sheet" aria-labelledby="accent-heading">
      <h2 id="accent-heading">{{ t('appearance.accentTitle') }}</h2>
      <ThemeStyleControls :model-value="style" section="accent" @update:model-value="applyStyle($event, 'accent')" />
      <p v-if="errorSection === 'accent'" class="settings-error" role="alert">{{ t('appearance.storageError') }}</p>
    </section>
    <section class="settings-sheet" aria-labelledby="background-heading">
      <h2 id="background-heading">{{ t('appearance.backgroundTitle') }}</h2>
      <ThemeStyleControls :key="activeId" :model-value="style" section="background" @update:model-value="applyStyle($event, 'background')" />
      <p v-if="errorSection === 'background'" class="settings-error" role="alert">{{ t('appearance.storageError') }}</p>
    </section>
  </SettingsPageFrame>
</template>

<style scoped>
.section-heading, .theme-name, .custom-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.create-theme { display: inline-flex; align-items: center; gap: 5px; min-height: 38px; padding: 5px 11px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--soft); color: var(--green); font-size: .85rem; font-weight: 650; text-decoration: none; }
.create-theme:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.preset-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(6px, 1.3vw, 11px); }
.preset-card { display: grid; text-align: start; min-width: 0; gap: 8px; padding: 5px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); }
.preset-card[aria-pressed="true"] { outline: 2px solid var(--green); outline-offset: -2px; }
.preset-card:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
.theme-name { padding: 0 3px 4px; font-weight: 600; font-size: .87rem; overflow-wrap: anywhere; }
.theme-name svg, .custom-theme svg { color: var(--green); flex: none; }
.custom-heading { padding-top: 8px; }
.custom-list { margin: 0; padding: 0; list-style: none; }
.custom-list li { flex-wrap: wrap; padding: 4px 0; border-top: 1px solid var(--line); }
.custom-theme, .remove-theme { min-height: 44px; border: 0; background: transparent; color: var(--ink); }
.custom-theme { flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px; padding: 5px 2px; font-weight: 600; overflow-wrap: anywhere; text-align: start; }
.custom-color { flex: none; width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--line); }
.remove-theme { display: grid; place-items: center; width: 44px; color: var(--sub); }
.remove-theme:hover { color: var(--danger-ink); }
.remove-prompt { flex: 1 1 8em; overflow-wrap: anywhere; }
@media (max-width: 420px) {
  .theme-name { gap: 2px; font-size: .82rem; }
}
</style>
