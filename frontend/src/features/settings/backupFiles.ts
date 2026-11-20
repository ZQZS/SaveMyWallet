import { invoke } from '@tauri-apps/api/core'

export interface SelectedBackupFile {
  name: string
  contents: string
}

export function chooseBackupFile(): Promise<SelectedBackupFile | null> {
  return invoke('choose_backup_file')
}

export function saveBackupFile(contents: string): Promise<boolean> {
  const now = new Date()
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  return invoke('save_backup_file', { contents, fileName: 'SaveMyWallet-' + day + '.json' })
}
