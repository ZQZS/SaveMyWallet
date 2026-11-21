import type { Entry } from '../domain/ledger.ts'
import { t } from '../i18n/index.ts'

export function entryStatusLabel(entry: Entry): string {
  if (entry.voided) return t('ledger.voided')
  if (entry.status === 'estimated') return t('ledger.needsConfirmation')
  if (entry.kind === 'estimate' && entry.amountCents === 0) return t('ledger.noBalancePayment')
  return t(entry.status === 'paid' ? 'ledger.paid' : 'ledger.unpaid')
}
