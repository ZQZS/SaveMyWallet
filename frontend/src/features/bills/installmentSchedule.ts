import { isMonth, shiftMonth } from '../../domain/ledger.ts'

export function readInstallmentSchedule(month: string, installmentCount: number, installmentIndex = 1) {
  if (!isMonth(month) || !Number.isInteger(installmentCount) || !Number.isInteger(installmentIndex)
      || installmentIndex < 1 || installmentIndex > installmentCount || installmentCount > 120) return null
  const remaining = installmentCount - installmentIndex + 1
  const firstMonth = shiftMonth(month, 1 - installmentIndex)
  const lastMonth = shiftMonth(month, remaining - 1)
  return isMonth(firstMonth) && isMonth(lastMonth) ? { remaining, lastMonth } : null
}
