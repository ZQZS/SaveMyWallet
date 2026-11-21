import assert from 'node:assert/strict'
import test from 'node:test'
import { projectInstallments, readInstallmentTerms } from '../src/features/ai/installmentScenario.ts'

function entry(amountCents, status, voided = false) {
  return {
    id: status + amountCents, platformId: 'shop', title: 'Sample', month: '2026-12',
    kind: status === 'estimated' ? 'estimate' : 'single', installmentIndex: null, installmentCount: null,
    amountCents, status, voided,
  }
}

test('逐月试算沿用账本口径，跨年工资覆盖和作废生效，试算不产生明细', () => {
  const ledger = {
    platforms: [{ id: 'shop', name: 'Shop' }],
    entries: [entry(30_000, 'paid'), entry(10_000, 'due'), entry(2_500, 'estimated'), entry(2_000, 'due', true)],
    settings: { defaultSalaryCents: 100_000, warningFloorCents: 45_000 },
    salaryOverrides: { '2027-01': 0, '2027-02': 70_000 },
  }
  const original = structuredClone(ledger)
  const { terms } = readInstallmentTerms('2026-12', '250.00', '3')
  assert.deepEqual(projectInstallments(ledger, terms), [
    { month: '2026-12', before: 57_500, after: 32_500, shortfall: 12_500 },
    { month: '2027-01', before: 0, after: -25_000, shortfall: 70_000 },
    { month: '2027-02', before: 70_000, after: 45_000, shortfall: 0 },
  ])
  assert.deepEqual(ledger, original)
})

test('试算与预填接受有效的分和期次，校验缺项、金额精度和整个分期的月份范围', () => {
  assert.deepEqual(readInstallmentTerms('2099-12', '0.01', '1'), {
    terms: { startMonth: '2099-12', amountCents: 1, installmentCount: 1 },
  })
  assert.equal(readInstallmentTerms('1900-01', '999999999', '120').terms.amountCents, 99_999_999_900)
  for (const [month, amount, count, error] of [
    ['', '1', '1', 'forms.monthError'], ['1899-12', '1', '1', 'forms.monthError'],
    ['2026-12', '0', '1', 'forms.amountError'], ['2026-12', '1.001', '1', 'forms.amountError'],
    ['2026-12', '1000000000', '1', 'forms.amountError'], ['2026-12', '200', '', 'forms.scheduleError'],
    ['2026-12', '200', '2.5', 'forms.scheduleError'], ['2026-12', '200', '121', 'forms.scheduleError'],
    ['2099-12', '1', '2', 'forms.scheduleError'],
  ]) {
    assert.deepEqual(readInstallmentTerms(month, amount, count), { error })
  }
})
