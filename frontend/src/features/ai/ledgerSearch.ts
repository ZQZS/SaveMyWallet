import { isMonth, type BillKind, type Entry, type LedgerData, type PaymentStatus } from '../../domain/ledger.ts'
import { matchesPlatformName, normalizedText } from './matchLedgerText.ts'

export interface LedgerSearchFilters {
  fromMonth: string | null
  toMonth: string | null
  platform: string | null
  title: string | null
  kind: BillKind | null
  statuses: PaymentStatus[]
  hasDeposit: boolean | null
  outstandingOnly: boolean
  voided: 'active' | 'voided' | 'all'
}

export interface LedgerSearchResult {
  entries: Entry[]
  due: number
  estimated: number
  paid: number
  total: number
}

export function searchLedger(ledger: LedgerData, filters: LedgerSearchFilters & { supported?: boolean }): LedgerSearchResult | null {
  const { fromMonth, toMonth, kind, statuses, hasDeposit, outstandingOnly, voided } = filters
  if ((filters.supported !== undefined && filters.supported !== true) ||
      (filters.title !== null && typeof filters.title !== 'string') ||
      (filters.platform !== null && typeof filters.platform !== 'string') ||
      (hasDeposit !== null && typeof hasDeposit !== 'boolean') || typeof outstandingOnly !== 'boolean' ||
      !['active', 'voided', 'all'].includes(voided) ||
      (kind !== null && !['estimate', 'installment', 'single'].includes(kind)) ||
      !Array.isArray(statuses) || statuses.some(status => !['estimated', 'due', 'paid'].includes(status)) ||
      (fromMonth !== null && !isMonth(fromMonth)) ||
      (toMonth !== null && !isMonth(toMonth)) || (fromMonth && toMonth && fromMonth > toMonth)) return null
  const platform = (filters.platform ?? '').trim()
  const title = normalizedText(filters.title ?? '')
  if (!fromMonth && !toMonth && !platform && !title && !kind && !statuses.length &&
      hasDeposit === null && !outstandingOnly && voided === 'active') return null

  const platformIds = platform ? new Set(ledger.platforms
    .filter(item => matchesPlatformName(item.name, platform)).map(item => item.id)) : null
  const entries = ledger.entries.filter(entry => {
    if (voided !== 'all' && Boolean(entry.voided) !== (voided === 'voided')) return false
    if ((fromMonth && entry.month < fromMonth) || (toMonth && entry.month > toMonth)) return false
    if ((kind && kind !== entry.kind) || (statuses.length && !statuses.includes(entry.status))) return false
    if (platformIds && !platformIds.has(entry.platformId)) return false
    if (title && !normalizedText(entry.title).includes(title)) return false
    if (hasDeposit !== null && (entry.kind !== 'estimate' || ((entry.depositCents ?? 0) > 0) !== hasDeposit)) return false
    return !outstandingOnly || (!entry.voided && entry.amountCents > 0 && entry.status !== 'paid')
  }).sort((a, b) => a.month.localeCompare(b.month))

  const result: LedgerSearchResult = { entries, estimated: 0, due: 0, paid: 0, total: 0 }
  for (const entry of entries) {
    if (entry.voided) continue
    result[entry.status] += entry.amountCents
    result.total += entry.amountCents
  }
  return Number.isSafeInteger(result.total) ? result : null
}
