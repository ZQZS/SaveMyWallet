import { invoke } from '@tauri-apps/api/core'
import type { LedgerData } from '../domain/ledger'
import type { LedgerRepository } from './repository'

export const sqliteRepository: LedgerRepository = {
  load: async () => {
    if (!('__TAURI_INTERNALS__' in window)) throw new Error('NATIVE_ONLY')
    return invoke<LedgerData>('load_ledger')
  },
  createPlatform: (name) => invoke<string>('create_platform', { name }),
  createBill: (input) => invoke<void>('create_bill', { input }),
  confirmEstimate: (input) => invoke<void>('confirm_estimate', { input }),
  setEntryVoided: (id, voided) => invoke<void>('set_entry_voided', { id, voided }),
  setInstallmentVoided: (id, voided) => invoke<string[]>('set_installment_voided', { id, voided }),
  setPayment: (ids, paid) => invoke<string[]>('set_payment', { ids, paid }),
  undoPayment: (ids, paid) => invoke<string[]>('undo_payment', { ids, paid }),
  saveBudget: (input) => invoke<void>('save_budget', { input }),
}
