export type SyncKind = 'platform' | 'entry' | 'setting' | 'override'
export type ConflictChoice = 'local' | 'server'

export interface SyncChange {
  kind: SyncKind
  id: string
  before: unknown
  after: unknown
}

export interface SyncRecord {
  kind: SyncKind
  id: string
  value: unknown
  version: string | null
}

export interface SyncConflict {
  operationId: string
  changes: SyncChange[]
  records: SyncRecord[]
  requiresRestore?: boolean
}

export interface SyncStatus {
  bound: boolean
  authenticated: boolean
  url: string | null
  ledgerId: string | null
  pending: number
  cursor: number
  undoableIds: string[]
  hasPreviousBackup: boolean
  conflicts: SyncConflict[]
}

export interface SyncPreview {
  ledgerId: string
  cursor: number
  platforms: number
  entries: number
  empty: boolean
}
