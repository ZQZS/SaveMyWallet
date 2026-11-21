export const MIN_MONTH = '1900-01'
export const MAX_MONTH = '2099-12'
export const MAX_AMOUNT_CENTS = 99_999_999_900

export interface Platform {
  id: string
  name: string
}

export type BillKind = 'single' | 'installment' | 'estimate'
export type PaymentStatus = 'due' | 'paid' | 'estimated'

export interface Entry {
  id: string
  platformId: string
  title: string
  month: string
  /** For an estimate this is the balance after the paid deposit. */
  amountCents: number
  depositCents?: number
  status: PaymentStatus
  voided?: boolean
  kind: BillKind
  installmentId?: string
  installmentIndex: number | null
  installmentCount: number | null
}

export interface LedgerData {
  platforms: Platform[]
  entries: Entry[]
  settings: { defaultSalaryCents: number; warningFloorCents: number }
  salaryOverrides: Record<string, number>
}

export interface BillInput {
  platformId: string
  title: string
  month: string
  amountCents: number
  kind: BillKind
  installmentCount: number
  totalCents?: number
  depositCents?: number
}

export interface BudgetInput {
  month: string
  defaultSalaryCents: number
  warningFloorCents: number
  overrideSalaryCents: number | null
}

export type EstimateInput = Pick<Entry, 'id' | 'title' | 'month' | 'amountCents'> & Pick<BillInput, 'totalCents' | 'depositCents'>

export function estimateTotalCents(entry: Pick<Entry, 'amountCents' | 'depositCents'>): number {
  return entry.amountCents + (entry.depositCents ?? 0)
}

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= MIN_MONTH && value <= MAX_MONTH
}

export function currentMonth(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonth(month: string, delta: number): string {
  const [year, oneBasedMonth] = month.split('-').map(Number)
  const offset = year * 12 + oneBasedMonth - 1 + delta
  return `${Math.floor(offset / 12)}-${String(offset % 12 + 1).padStart(2, '0')}`
}

/** Return a complete, unambiguous schedule in payment order for the scope picker. */
export function installmentPeriods(entries: Entry[], selected: Entry): Entry[] | null {
  const count = selected.installmentCount
  const index = selected.installmentIndex
  if (selected.kind !== 'installment' || !count || !index || count > 120 || index < 1 || index > count) return null
  const start = shiftMonth(selected.month, 1 - index)
  const periods = new Map<number, Entry>()
  for (const entry of entries) {
    if (entry.installmentId !== selected.installmentId) continue
    const period = entry.installmentIndex
    const matches = entry.kind === 'installment' && entry.platformId === selected.platformId
      && entry.title === selected.title && entry.amountCents === selected.amountCents && entry.installmentCount === count
      && period !== null && Number.isInteger(period) && period >= 1 && period <= count
      && entry.month === shiftMonth(start, period - 1)
    if (!matches) {
      // A shared ID must describe one schedule. Legacy entries can belong to other purchases.
      if (selected.installmentId) return null
      continue
    }
    if (periods.has(period)) return null
    periods.set(period, entry)
  }
  if (periods.size !== count || periods.get(index)?.id !== selected.id) return null
  return Array.from({ length: count }, (_, i) => periods.get(i + 1)!)
}

export function monthLabel(month: string): string {
  const [year, number] = month.split('-')
  return `${year} 年 ${Number(number)} 月`
}

const currency = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

export function money(cents: number): string {
  return currency.format(cents / 100)
}

export function toCents(text: string): number | null {
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!parts) return null
  const cents = Number(parts[1]) * 100 + Number((parts[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS ? cents : null
}

interface Amounts {
  total: number
  due: number
  paid: number
  estimated: number
}

export interface PlatformGroup extends Amounts {
  platform: Platform
  entries: Entry[]
}

export interface MonthlySummary extends Amounts {
  salary: number
  balance: number
  groups: PlatformGroup[]
}

export function summarize(ledger: LedgerData, month: string): MonthlySummary {
  const entriesByPlatform = new Map<string, Entry[]>()
  for (const entry of ledger.entries) {
    if (entry.month !== month) continue
    const entries = entriesByPlatform.get(entry.platformId)
    if (entries) entries.push(entry)
    else entriesByPlatform.set(entry.platformId, [entry])
  }

  const salary = ledger.salaryOverrides[month] ?? ledger.settings.defaultSalaryCents
  const summary: MonthlySummary = { salary, balance: salary, total: 0, due: 0, paid: 0, estimated: 0, groups: [] }
  for (const platform of ledger.platforms) {
    const entries = entriesByPlatform.get(platform.id)
    if (!entries) continue
    const group: PlatformGroup = { platform, entries, total: 0, due: 0, paid: 0, estimated: 0 }
    for (const entry of entries) {
      if (entry.voided) continue
      group.total += entry.amountCents
      group[entry.status] += entry.amountCents
    }
    for (const bucket of ['total', 'due', 'paid', 'estimated'] as const) summary[bucket] += group[bucket]
    summary.groups.push(group)
  }
  summary.balance = salary - summary.total
  return summary
}
