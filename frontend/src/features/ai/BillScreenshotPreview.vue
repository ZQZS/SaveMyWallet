<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../../i18n'

defineProps<{ src: string }>()
const emit = defineEmits<{ load: []; error: [] }>()
const isLong = ref(false)

function onLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  isLong.value = image.naturalHeight >= image.naturalWidth * 3
  emit('load')
}
</script>

<template>
  <figure class="bill-preview">
    <figcaption v-if="isLong" class="ledger-hint">{{ t('billImage.scrollPreview') }}</figcaption>
    <div class="preview-window" :class="{ scrollable: isLong }" :tabindex="isLong ? 0 : undefined"
      :role="isLong ? 'region' : undefined" :aria-label="isLong ? t('billImage.preview') : undefined">
      <img class="image-preview" :src="src" :alt="t('billImage.preview')" @load="onLoad" @error="emit('error')" />
    </div>
  </figure>
</template>

<style scoped>
.bill-preview { margin: 0; min-width: 0; }
.bill-preview figcaption { margin-bottom: 6px; }
.preview-window { overflow: hidden; border-radius: 8px; background: var(--soft); }
.preview-window.scrollable { max-height: 52vh; overflow-y: auto; }
.preview-window:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.image-preview { display: block; width: 100%; height: auto; max-height: 52vh; object-fit: contain; }
.scrollable .image-preview { max-height: none; }
</style>
