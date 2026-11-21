import assert from 'node:assert/strict'
import test from 'node:test'
import { readBillAmounts } from '../src/features/bills/billAmounts.ts'

test('预计补款表单按分扣除定金，支持未付定金及定金等于总价', () => {
  for (const [deposit, depositCents, amountCents] of [['', 0, 3001], ['20.02', 2002, 999], ['30.01', 3001, 0]]) {
    assert.deepEqual(readBillAmounts('estimate', '', '30.01', deposit), { totalCents: 3001, depositCents, amountCents })
  }
})

test('预计补款阻止无效金额，切换普通或分期账单只取其应还金额', () => {
  for (const total of ['', '0', '-1', '1000000000', '1.001']) {
    assert.equal(readBillAmounts('estimate', '80', total, '0'), 'forms.totalError')
  }
  for (const deposit of ['-1', '100.01', '1.001', 'abc']) {
    assert.equal(readBillAmounts('estimate', '', '100', deposit), 'forms.depositError')
  }
  for (const kind of ['single', 'installment']) {
    assert.deepEqual(readBillAmounts(kind, '12.50', '100', '30'), { amountCents: 1250 })
    assert.equal(readBillAmounts(kind, '0', '100', '30'), 'forms.amountError')
  }
})
