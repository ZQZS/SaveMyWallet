import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatistics } from '../src/features/statistics/statistics.ts'

const ledger = {
  platforms: [{ id: 'a', name: '信用卡' }, { id: 'b', name: '分期平台' }],
  entries: [],
  settings: { defaultSalaryCents: 10000, warningFloorCents: 0 },
  salaryOverrides: { '2026-12': 0 },
}

function entry(id, platformId, month, amountCents, status) {
  return {
    id, platformId, month, amountCents, status, title: id, kind: status === 'estimated' ? 'estimate' : 'single',
    installmentCount: null, installmentIndex: null,
  }
}

test('六个月曲线按月份升序，保留跨年及无账单月份，只使用区间内账单', () => {
  const entries = [
    entry('旧账单', 'a', '2026-07', 90000, 'paid'),
    entry('还款', 'a', '2026-12', 1100, 'paid'),
    entry('待还', 'b', '2026-12', 2500, 'due'),
    { ...entry('尾款', 'b', '2026-12', 1399, 'estimated'), depositCents: 1000 },
    { ...entry('作废', 'a', '2026-12', 88888, 'due'), voided: true },
    entry('下月', 'a', '2027-01', 5100, 'due'),
    entry('之后', 'a', '2027-02', 90000, 'estimated'),
  ]
  const series = buildStatistics({ ...ledger, entries }, '2027-01', 6)
  assert.deepEqual(series.map(row => row.month), ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'])
  assert.deepEqual(series[0], {
    month: '2026-08', total: 0, paid: 0, due: 0, estimated: 0, salary: 10000, balance: 10000, groups: [],
  })
  const { groups, ...december } = series[4]
  assert.deepEqual(december, {
    month: '2026-12', total: 4999, paid: 1100, due: 2500, estimated: 1399, salary: 0, balance: -4999,
  })
  assert.deepEqual(groups.map(group => [group.platform.id, group.total]), [['a', 1100], ['b', 3899]])
  assert.equal(series[5].balance, 4900)
})

test('十二月窗口包含首尾月份，账本最早月份之前不生成数据', () => {
  const year = buildStatistics(ledger, '2099-12', 12)
  assert.equal(year.length, 12)
  assert.equal(year[0].month, '2099-01')
  assert.equal(year[11].month, '2099-12')
  assert.deepEqual(buildStatistics(ledger, '1900-02', 6).map(row => row.month), ['1900-01', '1900-02'])
  assert.deepEqual(buildStatistics(ledger, '', 6), [])
})

test('自选区间包含跨年的首尾月，按月保留工资覆盖与负结余', () => {
  const entries = [
    entry('区间之前', 'a', '2026-11', 1500, 'due'),
    entry('首月', 'a', '2026-12', 2400, 'paid'),
    entry('末月', 'b', '2027-02', 3000, 'estimated'),
    entry('区间之后', 'a', '2027-03', 2000, 'due'),
  ]
  const book = { ...ledger, entries }
  const series = buildStatistics(book, '2026-12', '2027-02')
  assert.deepEqual(series.map(({ month, total, balance }) => [month, total, balance]), [
    ['2026-12', 2400, -2400], ['2027-01', 0, 10000], ['2027-02', 3000, 7000],
  ])
  assert.deepEqual(buildStatistics(book, '2026-12', '2026-12'), [series[0]])
})

test('自选区间可覆盖完整账本年月范围，拒绝反向、越界或缺失月份', () => {
  const series = buildStatistics(ledger, '1900-01', '2099-12')
  assert.equal(series.length, 2400)
  assert.equal(series[0].month, '1900-01')
  assert.equal(series.at(-1).month, '2099-12')
  for (const [start, end] of [
    ['2026-02', '2026-01'], ['1899-12', '1900-01'], ['2099-12', '2100-01'], ['', '2026-01'], ['2026-01', ''],
  ]) {
    assert.deepEqual(buildStatistics(ledger, start, end), [])
  }
})
