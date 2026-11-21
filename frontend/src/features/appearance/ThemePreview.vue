<script setup lang="ts">
import { computed } from 'vue'
import { WalletCards } from 'lucide-vue-next'
import { formatMoney, t } from '../../i18n'
import { themeVariables, type ThemeStyle } from './appearance'

const props = defineProps<{ styleConfig: ThemeStyle; compact?: boolean }>()
const colors = computed(() => themeVariables(props.styleConfig))
</script>

<template>
  <div class="theme-preview" :class="{ compact }" :style="colors" :aria-hidden="compact || undefined">
    <div v-if="compact" class="mini-sheet">
      <i class="mini-hero" /><i class="mini-line" /><i class="mini-line short" />
    </div>
    <template v-else>
      <span class="preview-label"><WalletCards :size="16" aria-hidden="true" />{{ t('appearance.preview') }}</span>
      <div class="sample-sheet">
        <div class="sample-balance">
          <span>{{ t('ledger.balance') }}</span>
          <strong>{{ formatMoney(328000) }}</strong>
        </div>
        <dl class="sample-figures">
          <div><dt>{{ t('ledger.salary') }}</dt><dd>{{ formatMoney(500000) }}</dd></div>
          <div><dt>{{ t('ledger.total') }}</dt><dd>{{ formatMoney(172000) }}</dd></div>
        </dl>
      </div>
    </template>
  </div>
</template>

<style scoped>
.theme-preview {
  display: grid; gap: 12px; min-width: 0; padding: clamp(16px, 3.5vw, 28px);
  background-color: var(--paper); background-image: var(--page-background-image); background-size: var(--page-background-size);
  background-position: center; color: var(--ink); border: 1px solid var(--line); border-radius: 15px;
}
.preview-label { display: inline-flex; align-items: center; gap: 7px; color: var(--sub); font-size: .82rem; font-weight: 650; }
.sample-sheet { display: grid; grid-template-columns: 1.25fr 1fr; min-width: 0; border: 1px solid var(--line);
  border-radius: 12px; overflow: hidden; background: var(--surface); }
.sample-balance, .mini-hero { background: var(--hero-bg); color: var(--hero-ink); }
.sample-balance { display: grid; align-content: center; gap: 5px; padding: clamp(16px, 3vw, 28px); }
.sample-balance span, .sample-figures dt { font-size: .8rem; }
.sample-balance strong { font-size: clamp(1.7rem, 4.5vw, 2.55rem); letter-spacing: -.05em; line-height: 1.12; }
.sample-figures { display: grid; align-content: center; gap: 10px; padding: 14px clamp(14px, 3vw, 25px); margin: 0;
  background-color: var(--surface); background-image: var(--page-background-image); background-size: var(--page-background-size); background-position: center; }
.sample-figures > div { display: flex; align-items: baseline; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; }
.sample-figures dt { color: var(--sub); }
.sample-figures dd { margin: 0; font-weight: 650; font-variant-numeric: tabular-nums; }
.compact { height: 65px; padding: 9px 18%; border-radius: 7px; }
.mini-sheet { min-width: 0; align-self: stretch; display: grid; grid-template-rows: minmax(10px, 1fr) 3px 3px;
  gap: 4px; padding: 5px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
.mini-hero { border-radius: 3px; }
.mini-line { width: 68%; background: var(--line); border-radius: 3px; }
.mini-line.short { width: 42%; }
@media (max-width: 420px) {
  .theme-preview:not(.compact) { padding: 14px; }
  .sample-figures { gap: 7px; }
  .sample-figures > div { display: grid; }
  .compact { padding-inline: 12%; }
}
</style>
