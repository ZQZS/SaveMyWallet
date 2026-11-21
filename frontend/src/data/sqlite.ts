import { invoke } from '@tauri-apps/api/core'
import type { LedgerData } from '../domain/ledger'
import type { LedgerRepository } from './repository'

function sqliteCommands(expectedRevision?: string): LedgerRepository {
  function write<T>(command: string, args: Record<string, unknown>) {
    return invoke<T>(command, expectedRevision === undefined ? args : { ...args, expectedRevision })
  }
  return {
    load,
    createPlatform: name => write<string>('create_platform', { name }),
    createBill: input => write<void>('create_bill', { input }),
    createBills: inputs => write<void>('create_bills', { inputs }),
    confirmEstimate: input => write<void>('confirm_estimate', { input }),
    setEntryVoided: (id, voided) => write<void>('set_entry_voided', { id, voided }),
    voidEntries: ids => write<string[]>('void_entries', { ids }),
    setInstallmentVoided: (id, voided) => write<string[]>('set_installment_voided', { id, voided }),
    setPayment: (ids, paid) => write<string[]>('set_payment', { ids, paid }),
    undoPayment: (ids, paid) => write<string[]>('undo_payment', { ids, paid }),
    saveBudget: input => write<void>('save_budget', { input }),
  }
}

async function load() {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('NATIVE_ONLY')
  return invoke<LedgerData>('load_ledger')
}

export const sqliteRepository: LedgerRepository = {
  ...sqliteCommands(),
  async beginReviewedWrite() {
    const { ledger, revision } = await invoke<{ ledger: LedgerData; revision: string }>('load_reviewed_ledger')
    return { ledger, repository: sqliteCommands(revision) }
  },
}
