import { isMonth, MAX_AMOUNT_CENTS, type BillInput, type Platform } from '../../domain/ledger.ts'
import { draftPlatformId, estimateAmountsConflict, type RecognizedBillDraft } from '../../integrations/ai/visionDrafts.ts'
import { readBillAmounts } from '../bills/billAmounts.ts'
import { readInstallmentSchedule } from '../bills/installmentSchedule.ts'

export interface ScreenshotReviewRow {
  draft: RecognizedBillDraft
  status: 'pending' | 'skipped' | 'saved'
}

export interface ScreenshotStatement {
  totalCents: number | null
}

export function screenshotAmountCents(draft: RecognizedBillDraft): number | null {
  let cents = draft.amountCents
  if (draft.kind === 'estimate') {
    if (estimateAmountsConflict(draft)) return null
    if (cents === null && draft.totalCents != null && draft.depositCents != null) cents = draft.totalCents - draft.depositCents
  }
  const minimum = draft.kind === 'estimate' ? 0 : 1
  return cents != null && Number.isSafeInteger(cents) && cents >= minimum && cents <= MAX_AMOUNT_CENTS ? cents : null
}

function summarizeScreenshotPeriod(rows: ScreenshotReviewRow[]) {
  let month: string | null = null
  let totalCents = 0
  if (!rows.length) return { totalCents: null, issue: 'billImage.noStatementItems' }
  for (const { draft } of rows) {
    const cents = screenshotAmountCents(draft)
    if (cents === null) return { totalCents: null, issue: 'billImage.incompleteAmounts' }
    if (!draft.month || !isMonth(draft.month)) return { totalCents: null, issue: 'billImage.missingPeriod' }
    if (month && month !== draft.month) return { totalCents: null, issue: 'billImage.mixedPeriods' }
    month = draft.month
    // Each row contributes only its payment in the displayed period, including saved and skipped rows.
    totalCents += cents
    if (!Number.isSafeInteger(totalCents)) return { totalCents: null, issue: 'billImage.totalOverflow' }
  }
  return { totalCents, issue: null }
}

export function screenshotPlatformId(platforms: Platform[], drafts: RecognizedBillDraft[], preferred?: string): string {
  if (preferred && platforms.some(platform => platform.id === preferred)) return preferred
  const hints = new Set(drafts.map(draft => draft.platformHint?.trim()).filter(Boolean))
  const matches = new Set(Array.from(hints, hint => draftPlatformId(platforms, hint)))
  return matches.size === 1 ? [...matches][0] : ''
}

function amountText(cents: number | null | undefined) {
  return cents != null && Number.isSafeInteger(cents) ? String(cents / 100) : ''
}

function reviewBill(draft: RecognizedBillDraft, platformId: string): BillInput | string {
  const title = draft.title?.trim()
  if (!title || Array.from(title).length > 120) return 'forms.titleError'
  if (!draft.month || !isMonth(draft.month)) return 'forms.monthError'
  const kind = draft.kind
  if (kind !== 'installment' && kind !== 'single' && kind !== 'estimate') return 'billImage.selectKind'
  if (kind === 'estimate') {
    if (estimateAmountsConflict(draft)) return 'billImage.amountConflict'
    if (draft.totalCents == null) return 'forms.totalError'
    if (!Number.isSafeInteger(draft.depositCents)) return 'billImage.checkDeposit'
  }
  const amounts = readBillAmounts(kind, amountText(draft.amountCents), amountText(draft.totalCents), amountText(draft.depositCents))
  if (typeof amounts === 'string') return amounts
  if (kind === 'estimate' && draft.amountCents != null && draft.amountCents !== amounts.amountCents) return 'billImage.amountConflict'
  const input = { platformId, title, month: draft.month, kind, ...amounts }
  if (kind !== 'installment') return { ...input, installmentCount: 1 }

  const { installmentIndex, installmentCount } = draft
  if (installmentIndex === null || installmentCount === null || !readInstallmentSchedule(draft.month, installmentCount, installmentIndex)) {
    return 'forms.reviewScheduleError'
  }
  return { ...input, installmentCount, ...(installmentIndex === undefined ? {} : { installmentIndex }) }
}

export function prepareScreenshotBatch(rows: ScreenshotReviewRow[], platformId: string, statement: ScreenshotStatement | null = null) {
  const issues = new Map<number, string>()
  const inputs: BillInput[] = []
  const currentPeriods = new Map<string, number>()
  let pendingCount = 0
  rows.forEach((row, index) => {
    if (row.status !== 'pending') return
    pendingCount++
    const input = reviewBill(row.draft, platformId)
    if (typeof input === 'string') {
      issues.set(index, input)
      return
    }
    const sum = (currentPeriods.get(input.month) ?? 0) + input.amountCents
    if (!Number.isSafeInteger(sum)) {
      issues.set(index, 'billImage.totalOverflow')
      return
    }
    currentPeriods.set(input.month, sum)
    inputs.push(input)
  })
  if (issues.size) currentPeriods.clear()
  const details = summarizeScreenshotPeriod(rows)
  const differenceCents = statement?.totalCents != null && details.totalCents !== null
    ? details.totalCents - statement.totalCents : null
  const canSaveTogether = platformId && !issues.size && (!statement || differenceCents === 0)
  return { pendingCount, issues, inputs: canSaveTogether ? inputs : [], currentPeriods, details, differenceCents }
}
