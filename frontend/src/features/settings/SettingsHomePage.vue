<script setup lang="ts">
import { Archive, Bot, Cable, ChevronRight, Languages, PawPrint, RotateCcw } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { languageOptions, locale, t } from '../../i18n'
import { usePets } from '../pets/usePets'

const { enabled, activePet, ready } = usePets()

const sections = [
  { key: 'general', links: [{ name: 'settings-language', key: 'language', icon: Languages }] },
  { key: 'data', links: [
    { name: 'settings-connections', key: 'connections', icon: Cable },
    { name: 'settings-backup', key: 'backup', icon: Archive },
    { name: 'settings-reset', key: 'reset', icon: RotateCcw },
  ] },
  { key: 'extensions', links: [
    { name: 'settings-ai', key: 'ai', icon: Bot },
    { name: 'settings-pets', key: 'pets', icon: PawPrint },
  ] },
] as const
</script>

<template>
  <section class="settings-home" aria-labelledby="settings-title">
    <h1 id="settings-title">{{ t('settings.title') }}</h1>
    <section v-for="section in sections" :key="section.key" :aria-labelledby="'settings-group-' + section.key">
      <h2 :id="'settings-group-' + section.key">{{ t('settings.group.' + section.key) }}</h2>
      <ul class="settings-links">
        <li v-for="link in section.links" :key="link.name">
          <RouterLink :to="{ name: link.name }" class="settings-link">
            <span class="item-icon"><component :is="link.icon" :size="19" aria-hidden="true" /></span>
            <span class="item-title">{{ t('settings.' + link.key + '.title') }}</span>
            <span v-if="link.key === 'language'" class="item-meta">{{ languageOptions.find(option => option.value === locale)?.label }}</span>
            <span v-else-if="link.key === 'ai'" class="item-meta">DeepSeek</span>
            <span v-else-if="link.key === 'pets' && ready" class="item-meta pet-name">{{ enabled ? activePet.name : t('pets.picker.off') }}</span>
            <ChevronRight class="item-arrow" :size="17" aria-hidden="true" />
          </RouterLink>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.settings-home { display: grid; gap: 22px; max-width: 720px; margin-inline: auto; }
.settings-home h1 { font-size: clamp(1.5rem, 3vw, 2rem); letter-spacing: -.04em; }
.settings-home h2 { margin-bottom: 9px; color: var(--sub); font-size: .875rem; }
.settings-links { margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.settings-links li + li { border-top: 1px solid var(--line); }
.settings-link { display: flex; align-items: center; gap: 12px; min-height: 58px; padding: 8px 16px; color: var(--ink); text-decoration: none; }
.settings-link:hover .item-title { text-decoration: underline; text-underline-offset: 3px; }
.settings-link:focus-visible { outline: 3px solid var(--green); outline-offset: 1px; border-radius: 9px; }
.item-icon { flex: none; display: grid; place-items: center; width: 33px; height: 33px; color: var(--green); background: var(--soft); border-radius: 9px; }
.item-title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.item-meta { color: var(--sub); font-size: .8rem; }
.pet-name { max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-arrow { flex: none; color: var(--sub); }
@media (max-width: 450px) {
  .settings-link { gap: 8px; padding-inline: 10px; }
}
</style>
