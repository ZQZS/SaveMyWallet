<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLedgerSession } from '../../app/ledgerSession'
import { t } from '../../i18n'
import {
  MAX_CUSTOM_THEMES, MAX_THEME_NAME_LENGTH, normalizeThemeName, presetStyle, themeBases, themeVariables,
  useAppearance, type ThemeBase, type ThemeStyle,
} from './appearance'
import ThemePreview from './ThemePreview.vue'
import ThemeStyleControls from './ThemeStyleControls.vue'
import '../settings/settings.css'

const router = useRouter()
const { busy, needsReload } = useLedgerSession()
const { style, customThemes, saveTheme } = useAppearance()
const draft = ref<ThemeStyle>({ ...style.value })
const steps = ['base', 'style', 'name'] as const
const step = ref(0)
const stepHeading = ref<HTMLHeadingElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const name = ref('')
const attempted = ref(false)
const saveFailed = ref(false)
const photoPreparing = ref(false)
const locked = computed(() => busy.value || needsReload.value)
const full = computed(() => customThemes.value.length >= MAX_CUSTOM_THEMES)
const nameError = computed(() => {
  const normalized = normalizeThemeName(name.value)
  if (!normalized) {
    const length = Array.from(name.value.trim()).length
    if (!length) return 'appearanceWizard.missingName'
    return length > MAX_THEME_NAME_LENGTH ? 'appearanceWizard.longName' : 'appearanceWizard.invalidName'
  }
  if (customThemes.value.some(theme => theme.name.toLowerCase() === normalized.toLowerCase())) {
    return 'appearanceWizard.duplicateName'
  }
  return ''
})

function selectBase(base: ThemeBase) {
  if (draft.value.base !== base) draft.value = presetStyle(base)
}

async function moveStep(offset: number) {
  const next = step.value + offset
  if (next < 0 || next >= steps.length) return
  step.value = next
  saveFailed.value = false
  await nextTick()
  stepHeading.value?.focus()
}

function returnToAppearance() {
  const target = { name: 'settings-appearance' }
  if (router.options.history.state.back === router.resolve(target).fullPath) router.back()
  else void router.replace(target)
}

function save() {
  if (locked.value || full.value) return
  attempted.value = true
  saveFailed.value = false
  if (nameError.value) {
    nameInput.value?.focus()
    return
  }
  if (saveTheme(name.value.trim(), draft.value)) returnToAppearance()
  else saveFailed.value = true
}
</script>

<template>
  <section class="settings-page wizard" aria-labelledby="theme-wizard-title">
    <header class="settings-header">
      <h1 id="theme-wizard-title">{{ t('appearanceWizard.title') }}</h1>
    </header>
    <ol class="steps" :aria-label="t('appearanceWizard.progress')">
      <li v-for="(item, index) in steps" :key="item" :aria-current="index === step ? 'step' : undefined">
        <span aria-hidden="true">{{ index + 1 }}</span>{{ t('appearanceWizard.step.' + item) }}
      </li>
    </ol>
    <div class="workspace">
      <section class="settings-sheet" aria-labelledby="theme-step-heading">
        <h2 id="theme-step-heading" ref="stepHeading" tabindex="-1">{{ t('appearanceWizard.heading.' + steps[step]) }}</h2>
        <p class="settings-muted">{{ t('appearanceWizard.hint.' + steps[step]) }}</p>

        <div v-if="step === 0" class="base-options" role="radiogroup" aria-labelledby="theme-step-heading">
          <label v-for="base in themeBases" :key="base" class="base-option" :class="{ selected: draft.base === base }">
            <span class="base-sample" aria-hidden="true" :style="themeVariables(presetStyle(base))"><i /><i /><i /></span>
            <span class="base-label">
              <input type="radio" name="wizard-base" :checked="draft.base === base" @change="selectBase(base)">
              {{ t('appearance.base.' + base) }}
            </span>
          </label>
        </div>
        <template v-else-if="step === 1">
          <h3>{{ t('appearance.control.accent') }}</h3>
          <ThemeStyleControls v-model="draft" section="accent" />
          <h3>{{ t('appearance.control.background') }}</h3>
          <ThemeStyleControls v-model="draft" section="background" @preparing="photoPreparing = $event" />
        </template>
        <form v-else id="name-custom-theme" class="settings-reset-form" novalidate @submit.prevent="save">
          <label for="theme-name">{{ t('appearanceWizard.name') }}</label>
          <input id="theme-name" ref="nameInput" v-model="name" name="themeName" type="text" autocomplete="off"
            :aria-invalid="attempted && nameError ? true : undefined"
            :aria-describedby="attempted && nameError ? 'theme-name-error' : undefined" @input="saveFailed = false">
          <p v-if="attempted && nameError" id="theme-name-error" class="settings-error" role="alert">
            {{ t(nameError, { max: MAX_THEME_NAME_LENGTH }) }}
          </p>
          <p v-if="full" class="settings-error" role="alert">{{ t('appearanceWizard.full', { max: MAX_CUSTOM_THEMES }) }}</p>
          <p v-else-if="saveFailed" class="settings-error" role="alert">{{ t('appearanceWizard.saveError') }}</p>
        </form>
        <div class="settings-actions wizard-actions">
          <button type="button" class="settings-button cancel" :disabled="locked" @click="returnToAppearance">{{ t('settings.action.cancel') }}</button>
          <button v-if="step > 0" type="button" class="settings-button" @click="moveStep(-1)">{{ t('appearanceWizard.back') }}</button>
          <button v-if="step < steps.length - 1" type="button" class="settings-button primary" :disabled="photoPreparing" @click="moveStep(1)">{{ t('appearanceWizard.next') }}</button>
          <button v-else type="submit" form="name-custom-theme" class="settings-button primary" :disabled="locked || full">{{ t('appearanceWizard.save') }}</button>
        </div>
      </section>
      <div class="preview"><ThemePreview :style-config="draft" /></div>
    </div>
  </section>
</template>

<style scoped>
.wizard { max-width: 960px; }
.steps { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 0; padding: 0; list-style: none; }
.steps li { display: flex; align-items: center; gap: 6px; color: var(--sub); font-size: .86rem; }
.steps span { display: grid; place-items: center; width: 1.55rem; height: 1.55rem; border-radius: 50%; border: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.steps [aria-current="step"] { color: var(--ink); font-weight: 650; }
.steps [aria-current="step"] span { background: var(--soft); border-color: var(--green); color: var(--green); }
.workspace { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.preview { min-width: 0; }
.base-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.base-option { display: grid; padding: 8px; gap: 6px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
.base-option.selected { border-color: var(--green); }
.base-sample { display: flex; align-items: end; gap: 3px; padding: 6px 10px; height: 38px; border-radius: 5px; background: var(--paper); border: 1px solid var(--line); }
.base-sample i { width: 20%; height: 48%; background: var(--green); border-radius: 2px 2px 0 0; }
.base-sample i:nth-child(2) { height: 87%; }
.base-sample i:last-child { height: 65%; }
.base-label { display: flex; align-items: center; gap: 5px; min-height: 26px; color: var(--ink); font-size: .87rem; overflow-wrap: anywhere; }
.base-label input { margin: 0; accent-color: var(--green); }
.wizard-actions { justify-content: flex-end; padding-top: 4px; }
.cancel { margin-inline-end: auto; }
@media (max-width: 740px) { .workspace { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 420px) {
  .base-options { grid-template-columns: minmax(0, 1fr); }
  .base-option { grid-template-columns: 56px 1fr; align-items: center; }
  .steps { gap: 6px 10px; }
}
</style>
