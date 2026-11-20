import { invoke } from '@tauri-apps/api/core'

export interface BackupSummary {
  platforms: number
  entries: number
  overrides: number
}

export const localBackup = {
  exportBackup: () => invoke<string>('export_backup'),
  previewBackup: (contents: string) => invoke<BackupSummary>('preview_backup', { contents }),
  importBackup: (contents: string) => invoke<void>('import_backup', { contents }),
  resetLedger: (confirmation: string) => invoke<void>('reset_ledger', { confirmation }),
}
