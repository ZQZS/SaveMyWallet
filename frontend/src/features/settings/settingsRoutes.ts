import type { RouteRecordRaw } from 'vue-router'
import SettingsHomePage from './SettingsHomePage.vue'
import AiSettingsPage from './AiSettingsPage.vue'
import LanguageSettingsPage from './LanguageSettingsPage.vue'
import BackupSettingsPage from './BackupSettingsPage.vue'
import ResetSettingsPage from './ResetSettingsPage.vue'
import PetSettingsPage from './PetSettingsPage.vue'
import ConnectionsSettingsPage from './ConnectionsSettingsPage.vue'

export const settingsRoutes: RouteRecordRaw[] = [
  { path: '', name: 'settings', component: SettingsHomePage },
  { path: 'language', name: 'settings-language', component: LanguageSettingsPage },
  { path: 'backup', name: 'settings-backup', component: BackupSettingsPage },
  { path: 'reset', name: 'settings-reset', component: ResetSettingsPage },
  { path: 'ai', name: 'settings-ai', component: AiSettingsPage },
  { path: 'pets', name: 'settings-pets', component: PetSettingsPage },
  { path: 'connections', name: 'settings-connections', component: ConnectionsSettingsPage },
]
