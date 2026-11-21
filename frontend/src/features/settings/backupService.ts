import { invoke } from '@tauri-apps/api/core'
import type { LedgerActionName } from '../ai/ledgerActions'

export interface BackupSummary {
  platforms: number
  entries: number
  overrides: number
}

export interface LedgerRestorePoint {
  daysAgo: 1 | 7
  date: string
  preview: BackupSummary | null
  revision: string
}

export interface AiUndoPreview {
  token: string
  action: LedgerActionName
  createdAt: number
  entryCount: number
  platformCount: number
  budgetCount: number
  items: { kind: 'entry' | 'platform' | 'setting' | 'override'; id: string; label: string }[]
  blocked: boolean
  blockedReason: string | null
}

export const localBackup = {
  exportBackup: () => invoke<string>('export_backup'),
  previewBackup: (contents: string) => invoke<BackupSummary>('preview_backup', { contents }),
  importBackup: (contents: string) => invoke<void>('import_backup', { contents }),
  resetLedger: (confirmation: string) => invoke<void>('reset_ledger', { confirmation }),
  listRestorePoints: () => invoke<LedgerRestorePoint[]>('list_ledger_restore_points'),
  restorePoint: ({ daysAgo, date, revision }: LedgerRestorePoint) =>
    invoke<void>('restore_ledger_point', { daysAgo, date, revision }),
  previewAiUndo: () => invoke<AiUndoPreview | null>('preview_last_ai_undo'),
  undoAiChange: (token: string) => invoke<void>('undo_last_ai_change', { token }),
}
