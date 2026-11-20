import { isMonth, MAX_AMOUNT_CENTS, type BillKind } from '../../domain/ledger.ts'

/** Unreviewed model output. Amount means each period's payable amount for an installment. */
export interface RecognizedBillDraft {
  platformHint: string | null
  title: string | null
  month: string | null
  amountCents: number | null
  kind: BillKind | null
  installmentCount: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

function readPositiveInteger(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null
}

/** Parse a provider's decoded JSON. Unknown fields never become ledger writes. */
export function readBillDrafts(response: unknown): RecognizedBillDraft[] {
  if (!isRecord(response) || !Array.isArray(response.drafts)) {
    throw new Error('识图响应缺少 drafts 数组。')
  }
  return response.drafts.map((row: unknown, index: number) => {
    if (!isRecord(row)) throw new Error(`第 ${index + 1} 条识图草稿格式有误。`)
    const kind = row.kind === 'single' || row.kind === 'installment' || row.kind === 'estimate' ? row.kind : null
    return {
      platformHint: readText(row.platformHint),
      title: readText(row.title),
      month: typeof row.month === 'string' && isMonth(row.month) ? row.month : null,
      amountCents: readPositiveInteger(row.amountCents, MAX_AMOUNT_CENTS),
      kind,
      installmentCount: kind === 'installment' ? readPositiveInteger(row.installmentCount, 120) : null,
    }
  })
}
