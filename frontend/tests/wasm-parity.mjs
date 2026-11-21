import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import initialize, { summarize } from '../../wasm-lib/bin/template/wwwroot/monthly.js'
import { MAX_AMOUNT_CENTS, summarize as reference } from '../src/domain/ledger.ts'

before(async () => {
  await initialize()
})

const december = '2026-12'
const january = '2027-01'
const platforms = [
  { id: 'shop', name: '商店' },
  { id: 'unused', name: '本月无账单' },
  { id: '卡/💳', name: '信用卡' },
]

function bill(id, platformId, month, amountCents, status) {
  return {
    id, platformId, title: '账单 ' + id, month, amountCents, status,
    kind: status === 'estimated' ? 'estimate' : 'single',
    installmentIndex: null, installmentCount: null,
  }
}

function ledger(entries) {
  return {
    platforms, entries,
    settings: { defaultSalaryCents: 800_000, warningFloorCents: 10_000 },
    salaryOverrides: { [december]: 0, [january]: 900_000 },
  }
}

test('WASM 按平台和录入顺序汇总三种状态，保留大额整数分和分期明细', () => {
  const data = ledger([
    bill('c2', '卡/💳', december, MAX_AMOUNT_CENTS, 'paid'),
    { ...bill('s1', 'shop', december, 13001, 'due'), kind: 'installment', installmentIndex: 2, installmentCount: 4 },
    { ...bill('c1', '卡/💳', december, MAX_AMOUNT_CENTS - 1, 'estimated'), depositCents: 1 },
    bill('jan', 'shop', january, 54050, 'due'),
    bill('orphan', 'missing-platform', december, 250, 'due'),
  ])

  assert.deepEqual(summarize(data, december), reference(data, december))
  assert.deepEqual(summarize(data, january), reference(data, january))

  data.entries[1].status = 'paid'
  assert.deepEqual(summarize(data, december), reference(data, december))

  data.entries[0].voided = true
  data.entries[1].voided = true
  assert.deepEqual(summarize(data, december), reference(data, december))
  delete data.entries[1].voided
  assert.deepEqual(summarize(data, december), reference(data, december))
})

test('WASM 空账本分别使用零工资覆盖、非零覆盖和默认工资', () => {
  const data = ledger([])
  for (const month of [december, january, '2027-02']) {
    assert.deepEqual(summarize(data, month), reference(data, month))
  }
})
