<script setup lang="ts">
import { ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'

defineProps<{ name: string; label: string; value: string }>()
const open = defineModel<boolean>('open', { default: false })
const summary = ref<HTMLElement | null>(null)

defineExpose({ focus: () => summary.value?.focus({ preventScroll: true }) })
</script>

<template>
  <details class="chat-disclosure" :data-panel="name" :open="open"
    @toggle.self="open = ($event.currentTarget as HTMLDetailsElement).open">
    <!-- Update the model before a picker can remount the conversation. Native toggle events are queued. -->
    <summary ref="summary" @click.prevent="open = !open">
      <span class="panel-label">{{ label }}</span>
      <span class="panel-value" :title="value">{{ value }}</span>
      <ChevronRight class="panel-chevron" :size="16" aria-hidden="true" />
    </summary>
    <slot />
  </details>
</template>

<style scoped>
.chat-disclosure { min-width: 0; }
summary {
  display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 32px;
  cursor: pointer; border-radius: 5px; font-size: .84rem; line-height: 1.35; list-style: none;
}
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline-offset: -2px; }
.panel-label { flex: none; font-weight: 650; }
.panel-value { min-width: 0; margin-inline-start: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-chevron { flex: none; }
.chat-disclosure[open] > summary .panel-chevron { transform: rotate(90deg); }
@media (pointer: coarse) { summary { min-height: 44px; } }
</style>
