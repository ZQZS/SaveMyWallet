import type { RouteRecordRaw } from 'vue-router'
import SettingsHomePage from './SettingsHomePage.vue'
import AiSettingsPage from './AiSettingsPage.vue'
import LanguageSettingsPage from './LanguageSettingsPage.vue'
import AuthorSettingsPage from './AuthorSettingsPage.vue'
import BackupSettingsPage from './BackupSettingsPage.vue'
import ResetSettingsPage from './ResetSettingsPage.vue'
import PetSettingsPage from './PetSettingsPage.vue'
import ConnectionsSettingsPage from './ConnectionsSettingsPage.vue'

export const settingsRoutes: RouteRecordRaw[] = [
  { path: '', name: 'settings', component: SettingsHomePage },
  { path: 'language', name: 'settings-language', component: LanguageSettingsPage },
  { path: 'appearance', name: 'settings-appearance', component: () => import('../appearance/AppearanceSettingsPage.vue') },
  { path: 'appearance/create', name: 'settings-theme-create', component: () => import('../appearance/ThemeWizard.vue') },
  { path: 'author', name: 'settings-author', component: AuthorSettingsPage },
  { path: 'backup', name: 'settings-backup', component: BackupSettingsPage },
  { path: 'reset', name: 'settings-reset', component: ResetSettingsPage },
  { path: 'ai', name: 'settings-ai', component: AiSettingsPage },
  { path: 'pets', name: 'settings-pets', component: PetSettingsPage },
  { path: 'reminders', name: 'settings-reminders', component: () => import('./ReminderTasksPage.vue') },
  { path: 'connections', name: 'settings-connections', component: ConnectionsSettingsPage },
]
