import { toCents, type BillInput } from '../../domain/ledger.ts'

type AmountFields = Pick<BillInput, 'amountCents' | 'totalCents' | 'depositCents'>

export function readBillAmounts(kind: BillInput['kind'] | '', amount: string, totalPrice: string, deposit: string):
  AmountFields | 'forms.amountError' | 'forms.totalError' | 'forms.depositError' {
  if (kind !== 'estimate') {
    const amountCents = toCents(amount)
    return amountCents !== null && amountCents > 0 ? { amountCents } : 'forms.amountError'
  }
  const totalCents = toCents(totalPrice)
  if (totalCents === null || totalCents === 0) return 'forms.totalError'
  const depositCents = toCents(deposit.trim() || '0')
  if (depositCents === null || depositCents > totalCents) return 'forms.depositError'
  return { totalCents, depositCents, amountCents: totalCents - depositCents }
}
