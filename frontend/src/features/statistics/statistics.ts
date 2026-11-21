import {
  isMonth, MIN_MONTH, shiftMonth, summarize, type Entry, type LedgerData, type MonthlySummary,
} from '../../domain/ledger.ts'

export type StatisticsRange = 6 | 12

export interface StatisticsMonth extends MonthlySummary {
  month: string
}

export function buildStatistics(
  ledger: LedgerData, endMonth: string, range: StatisticsRange, calculateMonth = summarize,
): StatisticsMonth[] {
  if (!isMonth(endMonth)) return []
  const months = new Map<string, Entry[]>()
  for (let offset = 1 - range; offset <= 0; offset++) {
    const month = shiftMonth(endMonth, offset)
    if (month >= MIN_MONTH) months.set(month, [])
  }
  for (const entry of ledger.entries) months.get(entry.month)?.push(entry)

  return Array.from(months, ([month, entries]) => ({
    month, ...calculateMonth({ ...ledger, entries }, month),
  }))
}
