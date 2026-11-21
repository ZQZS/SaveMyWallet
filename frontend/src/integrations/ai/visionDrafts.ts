import { isMonth, MAX_AMOUNT_CENTS, type BillKind } from '../../domain/ledger.ts'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
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
      month: typeof row.month === 'string' && isMonth(row.month) ? row.month : null,
      amountCents,
      ...(kind === 'estimate' ? readEstimateAmounts(row, amountCents) : {}),
      kind,
      installmentCount: kind === 'installment' ? readInteger(row.installmentCount, 1, 120) : null,
    }
  })
}
