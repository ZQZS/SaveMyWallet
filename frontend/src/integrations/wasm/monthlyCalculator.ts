import type { summarize } from '../../domain/ledger'

type MonthlyCalculator = typeof summarize

export interface WasmLedgerModule {
  default(): Promise<unknown>
  summarize: MonthlyCalculator
}

export function createWasmCalculatorLoader(importModule: () => Promise<WasmLedgerModule>) {
  let pending: Promise<MonthlyCalculator> | undefined

  async function initialize() {
    const module = await importModule()
    await module.default()
    return module.summarize
  }

  return function load(): Promise<MonthlyCalculator> {
    pending ??= initialize().catch(error => {
      pending = undefined
      throw error
    })
    return pending
  }
}
