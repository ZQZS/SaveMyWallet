import type { BillInput, BudgetInput, EstimateInput, LedgerData } from '../domain/ledger'

export interface LedgerRepository {
  load(): Promise<LedgerData>
  createPlatform(name: string): Promise<string>
  createBill(input: BillInput): Promise<void>
  createBills(inputs: BillInput[], operationId?: string): Promise<void>
  confirmEstimate(input: EstimateInput): Promise<void>
  setEntryVoided(id: string, voided: boolean): Promise<void>
  voidEntries(ids: string[], operationId?: string): Promise<string[]>
  setInstallmentVoided(id: string, voided: boolean): Promise<string[]>
  setPayment(ids: string[], paid: boolean, operationId?: string): Promise<string[]>
  undoPayment?(ids: string[], paid: boolean): Promise<string[]>
  saveBudget(input: BudgetInput): Promise<void>
}
