import { isMonth, shiftMonth, summarize, toCents, type Entry, type LedgerData } from '../../domain/ledger.ts'

export interface InstallmentTerms {
  startMonth: string
  amountCents: number
  installmentCount: number
}

type TermsResult = { terms: InstallmentTerms } | { error: string }

export function readInstallmentTerms(startMonth: string, amount: string, count: string): TermsResult {
  if (!isMonth(startMonth)) return { error: 'forms.monthError' }
  const amountCents = toCents(amount)
  if (amountCents === null || amountCents < 1) return { error: 'forms.amountError' }
  const installmentCount = Number(count)
  if (!/^\d+$/.test(count.trim()) || installmentCount < 1 || installmentCount > 120 ||
      !isMonth(shiftMonth(startMonth, installmentCount - 1))) {
    return { error: 'forms.scheduleError' }
  }
  return { terms: { startMonth, amountCents, installmentCount } }
}

export interface ScenarioMonth {
  month: string
  before: number
  after: number
  shortfall: number
}

export function projectInstallments(ledger: LedgerData, terms: InstallmentTerms): ScenarioMonth[] | null {
  const endMonth = shiftMonth(terms.startMonth, terms.installmentCount - 1)
  const entriesByMonth = new Map<string, Entry[]>()
  for (const entry of ledger.entries) {
    if (entry.month < terms.startMonth || entry.month > endMonth) continue
    const entries = entriesByMonth.get(entry.month)
    if (entries) entries.push(entry)
    else entriesByMonth.set(entry.month, [entry])
  }
  const rows: ScenarioMonth[] = []
  for (let index = 0; index < terms.installmentCount; index++) {
    const month = shiftMonth(terms.startMonth, index)
    const monthlyLedger = { ...ledger, entries: entriesByMonth.get(month) ?? [] }
    const { balance: before, total } = summarize(monthlyLedger, month)
    const after = before - terms.amountCents
    const shortfall = Math.max(0, ledger.settings.warningFloorCents - after)
    if (![total, before, after, shortfall].every(Number.isSafeInteger)) return null
    rows.push({ month, before, after, shortfall })
  }
  return rows
}
