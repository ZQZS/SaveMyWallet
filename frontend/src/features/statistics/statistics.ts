import {
  isMonth, MIN_MONTH, shiftMonth, summarize, type Entry, type LedgerData, type MonthlySummary,
} from '../../domain/ledger.ts'

export type StatisticsRange = 6 | 12

export interface StatisticsMonth extends MonthlySummary {
  month: string
}

export function statisticsStartMonth(endMonth: string, range: StatisticsRange): string {
  const start = shiftMonth(endMonth, 1 - range)
  return start < MIN_MONTH ? MIN_MONTH : start
}

/** Accept an inclusive start/end pair, or an ending month and a preset length. */
export function buildStatistics(
  ledger: LedgerData, month: string, endOrRange: string | StatisticsRange, calculateMonth = summarize,
): StatisticsMonth[] {
  if (!isMonth(month)) return []
  const startMonth = typeof endOrRange === 'number' ? statisticsStartMonth(month, endOrRange) : month
  const endMonth = typeof endOrRange === 'number' ? month : endOrRange
  if (!isMonth(endMonth) || startMonth > endMonth) return []

  const months = new Map<string, Entry[]>()
  for (let cursor = startMonth; cursor <= endMonth; cursor = shiftMonth(cursor, 1)) {
    months.set(cursor, [])
  }
  for (const entry of ledger.entries) months.get(entry.month)?.push(entry)

  return Array.from(months, ([month, entries]) => ({
    month, ...calculateMonth({ ...ledger, entries }, month),
  }))
}
