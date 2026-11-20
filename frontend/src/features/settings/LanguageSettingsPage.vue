<script setup lang="ts">
import { languageOptions, locale, setLocale, t } from '../../i18n'
import SettingsPageFrame from './SettingsPageFrame.vue'
</script>

<template>
  <SettingsPageFrame :title="t('settings.language.title')">
    <div class="settings-sheet">
      <fieldset class="language-options">
        <legend>{{ t('settings.language.display') }}</legend>
        <label v-for="option in languageOptions" :key="option.value" class="language-option">
          <input type="radio" name="display-language" :value="option.value" :checked="locale === option.value" @change="setLocale(option.value)" />
          <span :lang="option.value">{{ option.label }}</span>
        </label>
      </fieldset>
    </div>
  </SettingsPageFrame>
</template>

<style scoped>
.language-options { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
.language-options legend { margin-bottom: 10px; padding: 0; font-weight: 650; }
.language-option { display: flex; align-items: center; gap: 12px; cursor: pointer; min-height: 46px; }
.language-option + .language-option { border-top: 1px solid var(--line); }
.language-option input { width: 18px; height: 18px; margin: 0 2px; accent-color: var(--green); }
</style>
