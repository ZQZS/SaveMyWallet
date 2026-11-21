import { isMonth, MAX_AMOUNT_CENTS, type BillKind, type Platform } from '../../domain/ledger.ts'

/** Unreviewed model output. Amount means each period's payable amount for an installment. */
export interface RecognizedBillDraft {
  platformHint: string | null
  title: string | null
  month: string | null
  amountCents: number | null
  totalCents?: number | null
  depositCents?: number | null
  kind: BillKind | null
  installmentCount: number | null
}

export function draftPlatformId(platforms: Platform[], hint?: string | null, selectedId?: string): string {
  if (selectedId && platforms.some(platform => platform.id === selectedId)) return selectedId
  const name = hint?.trim().toLowerCase()
  return platforms.find(platform => platform.name.toLowerCase() === name)?.id ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

function readRepaymentMonth(value: unknown): string | null {
  // A numeric 2026.11 is unambiguous, but JSON turns both 2026.1 and 2026.10 into 2026.1.
  const text = typeof value === 'number' && /^\d{4}\.\d{2}$/.test(String(value)) ? String(value) : readText(value)
  if (!text) return null
  const date = text.normalize('NFKC')
    .replace(/^(?:已付定金[^,]*,\s*)?预计\s*/, '')
    .replace(/^(?:首期还款|尾款支付|还款|补款)(?:时间|日期|月份)?\s*:?\s*/, '')
    .replace(/\s*到货(?:后)?补款$/, '')
    .trim()
    .replace(/(?:T|\s+)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, '')
  const parts = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?$/.exec(date)
    ?? /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(date.replace(/[./]/g, '-'))
  if (!parts) return null
  const [, year, month, day] = parts
  const result = `${year}-${month.padStart(2, '0')}`
  if (!isMonth(result)) return null
  if (day) {
    const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    if (Number(day) < 1 || Number(day) > daysInMonth) return null
  }
  return result
}

function readInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function readEstimateAmounts(row: Record<string, unknown>, balance: number | null) {
  let totalCents = readInteger(row.totalCents, 1, MAX_AMOUNT_CENTS)
  let depositCents = readInteger(row.depositCents, 0, MAX_AMOUNT_CENTS)
  // Two stated amounts determine the third. A missing deposit is different from an explicit zero.
  if (balance !== null) {
    if (totalCents === null && depositCents !== null) totalCents = readInteger(depositCents + balance, 1, MAX_AMOUNT_CENTS)
    else if (depositCents === null && totalCents !== null) depositCents = readInteger(totalCents - balance, 0, MAX_AMOUNT_CENTS)
  }
  return { totalCents, depositCents }
}

export function estimateAmountsConflict(draft: RecognizedBillDraft): boolean {
  if (draft.kind !== 'estimate') return false
  const { amountCents: balance, totalCents, depositCents } = draft
  if (totalCents != null && totalCents < Math.max(balance ?? 0, depositCents ?? 0)) return true
  if (depositCents == null || balance === null) return false
  const sum = depositCents + balance
  return sum < 1 || sum > MAX_AMOUNT_CENTS || (totalCents != null && totalCents !== sum)
}

/** Parse a provider's decoded JSON. Unknown fields never become ledger writes. */
export function readBillDrafts(response: unknown): RecognizedBillDraft[] {
  if (!isRecord(response) || !Array.isArray(response.drafts)) {
    throw new Error('识图响应缺少 drafts 数组。')
  }
  return response.drafts.map((row: unknown, index: number) => {
    if (!isRecord(row)) throw new Error(`第 ${index + 1} 条识图草稿格式有误。`)
    const kind = row.kind === 'single' || row.kind === 'installment' || row.kind === 'estimate' ? row.kind : null
    const amountCents = readInteger(row.amountCents, kind === 'estimate' ? 0 : 1, MAX_AMOUNT_CENTS)
    return {
      platformHint: readText(row.platformHint),
      title: readText(row.title),
      month: readRepaymentMonth(row.repaymentTimeText) ?? readRepaymentMonth(row.month),
      amountCents,
      ...(kind === 'estimate' ? readEstimateAmounts(row, amountCents) : {}),
      kind,
      installmentCount: kind === 'installment' ? readInteger(row.installmentCount, 1, 120) : null,
    }
  })
}
