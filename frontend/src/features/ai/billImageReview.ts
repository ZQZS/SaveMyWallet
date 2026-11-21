import { isMonth, MAX_AMOUNT_CENTS, type BillInput, type Entry, type Platform } from '../../domain/ledger.ts'
import { draftPlatformId, estimateAmountsConflict, isHuabeiName, type RecognizedBillDraft } from '../../integrations/ai/visionDrafts.ts'
import { readBillAmounts } from '../bills/billAmounts.ts'
import { readInstallmentSchedule } from '../bills/installmentSchedule.ts'

export interface ScreenshotReviewRow {
  draft: RecognizedBillDraft
  status: 'pending' | 'skipped' | 'saved'
  skippedReview?: { platformId: string; matchId?: string }
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

type StatementLine = Pick<RecognizedBillDraft, 'kind' | 'month' | 'title' | 'amountCents' | 'installmentIndex' | 'installmentCount'>

function statementLineKey(line: StatementLine): string | null {
  const { kind, month, amountCents, installmentIndex, installmentCount } = line
  const title = line.title?.trim()
  if (!title || Array.from(title).length > 120 || !month || !isMonth(month)) return null
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) return null
  if (kind === 'single') return JSON.stringify([kind, month, title, amountCents])
  if (kind !== 'installment' || installmentIndex == null || installmentCount == null
    || !readInstallmentSchedule(month, installmentCount, installmentIndex)) return null
  return JSON.stringify([kind, month, title, amountCents, installmentIndex, installmentCount])
}

interface MatchContext {
  platform?: Platform
  batchPlatformId: string
  monthlyStatement: boolean
  edit?: { index: number; input: BillInput }
}

function isAlipayPlatform(name: string | null) {
  return name === '支付宝' || isHuabeiName(name ?? '')
}

export function findStatementMatches(rows: ScreenshotReviewRow[], existing: Entry[], { platform, batchPlatformId, monthlyStatement, edit }: MatchContext) {
  const matches = new Map<number, Entry>()
  if (!platform) return matches
  // A manually skipped match reserves only the original charge the reviewer actually saw.
  const reserved = new Set<string>()
  rows.forEach((row, index) => {
    if (row.status === 'skipped' && index !== edit?.index && row.skippedReview?.matchId) reserved.add(row.skippedReview.matchId)
  })
  const previousMatchId = edit && rows[edit.index]?.skippedReview?.matchId
  const editedKey = edit && previousMatchId ? statementLineKey(edit.input) : null
  let previousMatch: Entry | undefined
  const candidates = new Map<string, Entry[]>()
  // Pop matches in snapshot order, consuming each existing charge at most once.
  for (let i = existing.length - 1; i >= 0; i--) {
    const entry = existing[i]
    if (entry.platformId !== platform.id || entry.voided || entry.status === 'estimated' || reserved.has(entry.id)) continue
    const key = statementLineKey(entry)
    if (key === null) continue
    if (entry.id === previousMatchId && key === editedKey) {
      previousMatch = entry
      continue
    }
    const group = candidates.get(key)
    if (group) group.push(entry)
    else candidates.set(key, [entry])
  }
  const checkAll = monthlyStatement || isAlipayPlatform(platform.name)
  rows.forEach((row, index) => {
    const edited = edit?.index === index ? edit.input : undefined
    if (!edited && (row.status !== 'pending' || batchPlatformId !== platform.id)) return
    if (!checkAll && !isAlipayPlatform(row.draft.platformHint)) return
    if (edited && previousMatch) {
      matches.set(index, previousMatch)
      return
    }
    const key = statementLineKey(edited ?? row.draft)
    const entry = key === null ? undefined : candidates.get(key)?.pop()
    if (entry) matches.set(index, entry)
  })
  return matches
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

export function prepareScreenshotBatch(
  rows: ScreenshotReviewRow[], platformId: string, statement: ScreenshotStatement | null = null,
  excludedMatches?: ReadonlyMap<number, Entry>, selectedIndices?: ReadonlySet<number>,
) {
  const issues = new Map<number, string>()
  const inputs: BillInput[] = []
  const currentPeriods = new Map<string, number>()
  const eligibleIndices: number[] = []
  const pendingIndices: number[] = []
  rows.forEach((row, index) => {
    if (row.status !== 'pending' || excludedMatches?.has(index)) return
    eligibleIndices.push(index)
    if (selectedIndices && !selectedIndices.has(index)) return
    pendingIndices.push(index)
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
  return { eligibleIndices, pendingCount: pendingIndices.length, pendingIndices, issues,
    inputs: canSaveTogether ? inputs : [], currentPeriods, details, differenceCents }
}
