<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { Check, Grid2X2, Grip, Image as ImageIcon, Square } from 'lucide-vue-next'
import { t } from '../../i18n'
import { accentColors, type ThemeStyle } from './appearance'
import { prepareThemePhoto, ThemePhotoError } from './themePhoto'

const props = defineProps<{ modelValue: ThemeStyle; section: 'accent' | 'background' }>()
const emit = defineEmits<{ 'update:modelValue': [style: ThemeStyle]; preparing: [active: boolean] }>()
const accentGroup = useId()
const backgroundOptions = [
  { value: 'plain', icon: Square },
  { value: 'dots', icon: Grip },
  { value: 'grid', icon: Grid2X2 },
  { value: 'photo', icon: ImageIcon },
] as const

const fileInput = ref<HTMLInputElement | null>(null)
const preparing = ref(false)
const photoError = ref('')
let request = 0

function invalidatePhoto() {
  request++
  preparing.value = false
  photoError.value = ''
}

watch([() => props.modelValue.base, () => props.modelValue.background, () => props.modelValue.photo, () => props.section],
  invalidatePhoto, { flush: 'sync' })
watch(preparing, value => emit('preparing', value), { flush: 'sync' })
onBeforeUnmount(invalidatePhoto)

function setAccent(value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return
  const accent = value.toLowerCase() as ThemeStyle['accent']
  if (accent !== props.modelValue.accent) emit('update:modelValue', { ...props.modelValue, accent })
}

function pickPhoto() {
  invalidatePhoto()
  fileInput.value?.click()
}

function setBackground(background: ThemeStyle['background']) {
  if (background === 'photo' && !props.modelValue.photo) {
    pickPhoto()
    return
  }
  invalidatePhoto()
  if (background !== props.modelValue.background) emit('update:modelValue', { ...props.modelValue, background })
}

async function readPhoto(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const current = ++request
  photoError.value = ''
  preparing.value = true
  try {
    const photo = await prepareThemePhoto(file)
    if (current === request) emit('update:modelValue', { ...props.modelValue, background: 'photo', photo })
  } catch (error) {
    if (current === request) photoError.value = error instanceof ThemePhotoError ? error.code : 'decode'
  } finally {
    if (current === request) preparing.value = false
  }
}
</script>

<template>
  <fieldset v-if="section === 'accent'" class="style-controls">
    <legend class="visually-hidden">{{ t('appearance.control.accent') }}</legend>
    <div class="swatches">
      <label v-for="color in accentColors" :key="color" class="swatch" :title="t('appearance.control.color.' + color.slice(1))">
        <input type="radio" :name="accentGroup" :value="color" :checked="modelValue.accent.toLowerCase() === color"
          :aria-label="t('appearance.control.color.' + color.slice(1))" @change="setAccent(color)" />
        <span class="swatch-disc" :style="{ backgroundColor: color }"><Check :size="14" aria-hidden="true" /></span>
      </label>
      <label class="custom-color">
        <input type="color" :value="modelValue.accent" @change="setAccent(($event.target as HTMLInputElement).value)" />
        <span class="current-color" aria-hidden="true" :style="{ backgroundColor: modelValue.accent }"></span>
        <span>{{ t('appearance.control.custom') }}</span>
        <code aria-hidden="true">{{ modelValue.accent.toUpperCase() }}</code>
      </label>
    </div>
  </fieldset>
  <fieldset v-else class="style-controls">
    <legend class="visually-hidden">{{ t('appearance.control.background') }}</legend>
    <div class="background-options">
      <button v-for="{ value, icon } in backgroundOptions" :key="value" type="button" :aria-pressed="modelValue.background === value"
        @click="setBackground(value)">
        <component :is="icon" :size="18" aria-hidden="true" />{{ t('appearance.control.' + value) }}
      </button>
    </div>
    <input ref="fileInput" type="file" hidden accept="image/jpeg,image/png,image/webp" @change="readPhoto" />
    <button v-if="modelValue.background === 'photo'" type="button" class="pick-photo" @click="pickPhoto">
      {{ t('appearance.control.replacePhoto') }}
    </button>
    <p v-if="preparing" class="photo-status" role="status">{{ t('appearance.control.preparing') }}</p>
    <p v-if="photoError" class="photo-error" role="alert">{{ t('appearance.control.error.' + photoError) }}</p>
  </fieldset>
</template>

<style scoped>
.style-controls { min-width: 0; margin: 0; padding: 0; border: 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
.swatches, .background-options { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.swatch { position: relative; display: inline-grid; place-items: center; width: 44px; height: 44px; cursor: pointer; }
.swatch input { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.swatch-disc { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid color-mix(in srgb, var(--ink) 25%, transparent); border-radius: 50%; }
.swatch-disc svg { visibility: hidden; color: #18251d; background: white; border-radius: 50%; stroke-width: 3; }
.swatch input:checked + .swatch-disc { outline: 2px solid var(--ink); outline-offset: 2px; }
.swatch input:checked + .swatch-disc svg { visibility: visible; }
.swatch:has(:focus-visible), .custom-color:has(:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 1px; border-radius: 7px; }
.custom-color { min-width: 0; display: inline-flex; position: relative; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 44px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); cursor: pointer; font-size: .86rem; }
.custom-color input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.current-color { width: 14px; height: 14px; border: 1px solid var(--line); border-radius: 50%; }
.custom-color code { color: var(--sub); font-size: .78rem; }
.background-options { gap: 8px; }
.background-options button, .pick-photo { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font-size: .88rem; }
.background-options button[aria-pressed="true"] { color: var(--green); background: var(--soft); border-color: var(--green); box-shadow: inset 0 0 0 1px var(--green); }
.pick-photo { margin-top: 8px; }
.photo-status, .photo-error { margin-top: 8px; font-size: .85rem; line-height: 1.5; color: var(--sub); }
.photo-error { color: var(--danger-ink); }
</style>
