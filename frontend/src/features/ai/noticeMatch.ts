import { isMonth, MAX_AMOUNT_CENTS, type Entry, type LedgerData } from '../../domain/ledger.ts'
import { matchesPlatformName, normalizedText } from './matchLedgerText.ts'

export interface NoticeDraft {
  title: string | null
  platformHint: string | null
  month: string | null
  amountCents: number | null
  totalCents: number | null
  depositCents: number | null
}

/** Keep every eligible entry available for manual selection. Prices and months can change. */
export function findNoticeCandidates(ledger: LedgerData, notice: NoticeDraft) {
  const platformNames = new Map(ledger.platforms.map(platform => [platform.id, platform.name]))
  const platform = notice.platformHint?.trim()
  const title = normalizedText(notice.title ?? '')
  return ledger.entries.filter(entry => entry.kind === 'estimate' && entry.status === 'estimated' && !entry.voided)
    .map(entry => {
      const entryTitle = normalizedText(entry.title)
      const titleMatches = entryTitle.length > 0 && (entryTitle.includes(title) || title.includes(entryTitle))
      const platformMatches = !platform || matchesPlatformName(platformNames.get(entry.platformId) ?? '', platform)
      return { entry, matched: Boolean(title || platform) && platformMatches && (!title || titleMatches) }
    })
    .sort((a, b) => Number(b.matched) - Number(a.matched))
}

function validAmount(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= MAX_AMOUNT_CENTS
}

/** Prefill a proposed confirmation without replacing the deposit already recorded by the user. */
export function prepareNoticeReview(entry: Entry, notice: NoticeDraft) {
  const savedDeposit = entry.depositCents ?? 0
  const { amountCents: balance, totalCents, depositCents } = notice
  const total = totalCents ?? (balance === null ? null : savedDeposit + balance)
  const conflict =
    !validAmount(savedDeposit, 0) || (depositCents !== null && depositCents !== savedDeposit) ||
    (balance !== null && !validAmount(balance, 0)) ||
    (total !== null && (!validAmount(total, 1) || total < savedDeposit)) ||
    (balance !== null && total !== savedDeposit + balance)
  return {
    month: notice.month && isMonth(notice.month) ? notice.month : '',
    totalPrice: total !== null && !conflict ? String(total / 100) : '',
    deposit: String(savedDeposit / 100),
    conflict,
  }
}
