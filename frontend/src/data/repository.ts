import type { BillInput, BudgetInput, EstimateInput, LedgerData } from '../domain/ledger'

export interface LedgerRepository {
  load(): Promise<LedgerData>
  createPlatform(name: string): Promise<string>
  createBill(input: BillInput): Promise<void>
  confirmEstimate(input: EstimateInput): Promise<void>
  setEntryVoided(id: string, voided: boolean): Promise<void>
  setInstallmentVoided(id: string, voided: boolean): Promise<string[]>
  setPayment(ids: string[], paid: boolean): Promise<string[]>
  undoPayment?(ids: string[], paid: boolean): Promise<string[]>
  saveBudget(input: BudgetInput): Promise<void>
}
