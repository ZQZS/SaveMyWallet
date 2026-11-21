import assert from 'node:assert/strict'
import test from 'node:test'
import { currentMonth, estimateTotalCents, installmentPeriods, isMonth, projectBillingMonths, shiftMonth, summarize, summarizePlatforms, toCents } from '../src/domain/ledger.ts'

const platform = { id: 'custom-id', name: '新增平台' }
const current = '2026-12'

function entry(id, amountCents, status, month = current) {
  return {
    id, platformId: platform.id, title: id, month, amountCents, status,
    kind: status === 'estimated' ? 'estimate' : 'single',
    installmentIndex: null, installmentCount: null,
  }
}

function book(entries) {
  return {
    platforms: [platform, { id: 'unused', name: '本月无账单' }], entries,
    settings: { defaultSalaryCents: 800_000, warningFloorCents: 500_000 },
    salaryOverrides: { [current]: 600_000 },
  }
}

test('总价 100 元已付 20 元定金，月度预算与还款状态只计入 80 元尾款', () => {
  const estimate = { ...entry('预订', 8000, 'estimated'), depositCents: 2000 }
  const prepaid = { ...entry('已付全款', 0, 'paid'), kind: 'estimate', depositCents: 10000 }
  const ledger = book([estimate, prepaid])
  assert.equal(estimateTotalCents(estimate), 10000)
  assert.equal(estimateTotalCents(prepaid), 10000)
  assert.equal(estimateTotalCents(entry('旧款项', 8000, 'estimated')), 8000)
  for (const status of ['estimated', 'due', 'paid']) {
    estimate.status = status
    const summary = summarize(ledger, current)
    assert.deepEqual([summary.total, summary.balance, summary[status]], [8000, 592000, 8000])
  }
  estimate.voided = true
  assert.equal(summarize(ledger, current).total, 0)
})

test('月度预测按动态平台合并，仅计目标月份，并把预估纳入结余', () => {
  const ledger = book([
    entry('已还', 10101, 'paid'), entry('待还', 20202, 'due'), entry('预估', 30303, 'estimated'),
    entry('下月', 400004, 'due', '2027-01'),
  ])
  const s = summarize(ledger, current)
  assert.deepEqual([s.paid, s.due, s.estimated, s.total, s.balance], [10101, 20202, 30303, 60606, 539394])
  assert.deepEqual(s.groups.map(g => [g.platform.name, g.entries.length]), [['新增平台', 3]])
  const next = summarize(ledger, shiftMonth(current, 1))
  assert.equal(next.salary, 800000)
  assert.ok(next.balance < ledger.settings.warningFloorCents)
})

test('跨年只顺延过月且未作废的待确认预计补款，包含零尾款', () => {
  const overdue = { ...entry('尾款', 8000, 'estimated', '2026-11'), depositCents: 2000 }
  const prepaid = { ...entry('预付全款', 0, 'estimated'), depositCents: 1000 }
  const fixed = [
    entry('本月预估', 200, 'estimated', '2027-01'), entry('未来预估', 300, 'estimated', '2027-02'),
    { ...entry('作废', 50, 'estimated'), voided: true },
    { ...entry('已确认', 60, 'due'), kind: 'estimate' }, { ...entry('已还', 70, 'paid'), kind: 'estimate' },
    entry('单次', 80, 'due'), { ...entry('分期', 90, 'due'), kind: 'installment' },
  ]
  const ledger = book([overdue, prepaid, ...fixed])
  const january = projectBillingMonths(ledger, '2027-01')
  assert.deepEqual(january.entries.slice(0, 2), [
    { ...overdue, month: '2027-01', carriedFromMonth: '2026-11' },
    { ...prepaid, month: '2027-01', carriedFromMonth: current },
  ])
  for (const [index, row] of fixed.entries()) assert.equal(january.entries[index + 2], row)
  assert.equal(overdue.month, '2026-11')
  assert.equal(overdue.carriedFromMonth, undefined)
  assert.equal(projectBillingMonths(january, '2027-01'), january)
  assert.equal(projectBillingMonths(ledger, '2026-11'), ledger)
  assert.equal(projectBillingMonths(ledger, '2100-01'), ledger)
  const february = projectBillingMonths(january, '2027-02')
  assert.deepEqual(february, projectBillingMonths(ledger, '2027-02'))
  assert.equal(summarize(february, '2026-11').estimated, 0)
  assert.equal(summarize(february, '2027-01').estimated, 0)
  assert.equal(summarize(february, '2027-02').estimated, 8500)
  assert.deepEqual(summarizePlatforms(february), summarizePlatforms(ledger))
})

test('确认顺延尾款后按实际确认月计一次，后续自然月不再顺延', () => {
  const original = { ...entry('预订', 8000, 'estimated'), depositCents: 2000 }
  assert.equal(projectBillingMonths(book([original]), '2027-01').entries[0].month, '2027-01')
  const confirmed = { ...original, month: '2027-02', amountCents: 7500, status: 'due' }
  const saved = book([confirmed])
  const march = projectBillingMonths(saved, '2027-03')
  assert.equal(march, saved)
  assert.deepEqual([current, '2027-01', '2027-02', '2027-03'].map(month => summarize(march, month).total), [0, 0, 7500, 0])
})

test('各平台按全部月份汇总实际分期、已还、待还和待确认笔数及金额', () => {
  const first = { ...entry('分期一', 1250, 'paid'), kind: 'installment', installmentIndex: 1, installmentCount: 2 }
  const second = { ...first, id: '分期二', month: '2027-01', status: 'due', installmentIndex: 2 }
  const ledger = book([
    first, second,
    { ...entry('尾款', 800, 'estimated'), depositCents: 200 },
    { ...entry('预付结清', 0, 'paid'), kind: 'estimate', depositCents: 999 },
    { ...entry('作废', 9999, 'due'), voided: true },
    { ...entry('另一平台', 20, 'due'), platformId: 'other' },
  ])
  const other = { id: 'other', name: '另一平台' }
  ledger.platforms.push(other)
  const summaries = summarizePlatforms(ledger)
  assert.deepEqual(summaries.get(platform.id), {
    platform,
    total: 3300, paid: 1250, due: 1250, estimated: 800,
    entryCount: 5, paidCount: 2, dueCount: 1, estimatedCount: 1, voidedCount: 1,
  })
  assert.deepEqual(summaries.get('other'), {
    platform: other,
    total: 20, paid: 0, due: 20, estimated: 0,
    entryCount: 1, paidCount: 0, dueCount: 1, estimatedCount: 0, voidedCount: 0,
  })
  assert.deepEqual(summaries.get('unused'), {
    platform: ledger.platforms[1],
    total: 0, paid: 0, due: 0, estimated: 0,
    entryCount: 0, paidCount: 0, dueCount: 0, estimatedCount: 0, voidedCount: 0,
  })
})

test('还款勾选只减少待还，补录后已还与待还并存', () => {
  const ledger = book([entry('初始账单', 1249, 'due')])
  const before = summarize(ledger, current)
  ledger.entries[0].status = 'paid'
  const paid = summarize(ledger, current)
  assert.equal(paid.due, 0)
  assert.equal(paid.balance, before.balance)
  ledger.entries.push(entry('补录', 250, 'due'))
  const group = summarize(ledger, current).groups[0]
  assert.deepEqual([group.due, group.paid, group.total], [250, 1249, 1499])
})

test('作废记录保留顺序和原状态，恢复后金额重新计入原分类', () => {
  const rows = [entry('已还', 99_999_999_900, 'paid'), entry('待还', 1, 'due'), entry('预估', 2580, 'estimated')]
  const ledger = book(rows)
  for (const row of rows) row.voided = true
  const voided = summarize(ledger, current)
  assert.deepEqual([voided.paid, voided.due, voided.estimated, voided.total, voided.balance], [0, 0, 0, 0, 600_000])
  assert.deepEqual(voided.groups[0], { platform, entries: rows, total: 0, due: 0, paid: 0, estimated: 0 })

  delete rows[0].voided
  const restored = summarize(ledger, current)
  assert.deepEqual([restored.paid, restored.due, restored.estimated, restored.total, restored.balance],
    [99_999_999_900, 0, 0, 99_999_999_900, 600_000 - 99_999_999_900])
})

test('作废分期只影响所选那一期', () => {
  const nextMonth = shiftMonth(current, 1)
  const ledger = book([
    { ...entry('第 1 期', 6900, 'due'), kind: 'installment', installmentIndex: 1, installmentCount: 2, voided: true },
    { ...entry('第 2 期', 6900, 'due', nextMonth), kind: 'installment', installmentIndex: 2, installmentCount: 2 },
  ])
  assert.equal(summarize(ledger, current).total, 0)
  assert.equal(summarize(ledger, nextMonth).due, 6900)
})

test('整笔分期按组标识跨年定位，旧分期必须每个期号恰好一条', () => {
  const first = { ...entry('a1', 6900, 'paid'), title: '月供', kind: 'installment', installmentIndex: 1, installmentCount: 2 }
  const second = { ...first, id: 'a2', month: '2027-01', installmentIndex: 2, status: 'due', voided: true }
  const other = [{ ...first, id: 'b1' }, { ...second, id: 'b2' }]
  assert.deepEqual(installmentPeriods([second, first], second), [first, second])
  assert.equal(installmentPeriods([first], first), null)
  assert.equal(installmentPeriods([first, second, ...other], second), null)

  const groupA = [first, second].map(row => ({ ...row, installmentId: 'a'.repeat(32) }))
  const groupB = other.map(row => ({ ...row, installmentId: 'b'.repeat(32) }))
  const all = [...groupB, ...groupA, first, second]
  assert.deepEqual(installmentPeriods(all, groupA[1]), groupA)
  assert.deepEqual(installmentPeriods(all, second), [first, second])
  assert.equal(installmentPeriods([groupA[0], { ...groupA[1], month: '2027-02' }], groupA[0]), null)
})

test('从第 3/4 期录入的月账单只展示已入账期次，作废范围限于单期', () => {
  const third = { ...entry('p3', 6900, 'due'), title: '月供', kind: 'installment',
    installmentId: 'a'.repeat(32), installmentIndex: 3, installmentCount: 4 }
  const fourth = { ...third, id: 'p4', month: '2027-01', installmentIndex: 4 }
  const ledger = book([third, fourth])
  assert.equal(installmentPeriods(ledger.entries, fourth), null)
  assert.deepEqual(summarize(ledger, '2026-11').groups, [])
  assert.deepEqual(summarize(ledger, current).groups[0].entries, [third])
  third.voided = true
  assert.equal(summarize(ledger, current).due, 0)
  assert.equal(summarize(ledger, '2027-01').due, 6900)
})

test('单月工资允许为零，清空覆盖后使用默认工资', () => {
  const ledger = book([])
  ledger.salaryOverrides[current] = 0
  assert.equal(summarize(ledger, current).balance, 0)
  delete ledger.salaryOverrides[current]
  assert.equal(summarize(ledger, current).balance, 800000)
})

test('金额按分解析，月份按设备本地日历跨年', () => {
  assert.deepEqual(['0.29','2.1','0','999999999'].map(toCents), [29,210,0,99999999900])
  for (const invalid of ['1.002','1e4','','-1','1000000000','Infinity']) assert.equal(toCents(invalid), null)
  assert.equal(currentMonth(new Date(2026, 0, 1, 0, 0)), '2026-01')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-12', 2), '2027-02')
  assert.ok(!isMonth('2099-13') && !isMonth('2100-01'))
})
