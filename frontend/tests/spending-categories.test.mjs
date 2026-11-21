import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatistics } from '../src/features/statistics/statistics.ts'
import { analyzeCategorySpending, prepareCategorySpending } from '../src/features/statistics/spendingCategories.ts'

function entry(id, title, amountCents, overrides = {}) {
  return { id, title, amountCents, kind: 'single', status: 'paid', month: '2027-01', platformId: 'a',
    installmentIndex: null, installmentCount: null, ...overrides }
}

function statistics(entries) {
  return buildStatistics({
    platforms: [{ id: 'a', name: '平台 A' }, { id: 'b', name: '平台 B' }],
    entries, settings: { defaultSalaryCents: 12345, warningFloorCents: 0 }, salaryOverrides: {},
  }, '2027-01', 6)
}

test('AI 只接收去重的名称，分期与预计尾款按月度账本口径在本机统计笔数和占比', async () => {
  const series = statistics([
    entry('first', '月票', 500, { month: '2026-12', kind: 'installment' }),
    entry('second', '月票', 500, { status: 'due', kind: 'installment', platformId: 'b' }),
    entry('estimate', '聚餐', 299, { kind: 'estimate', status: 'estimated', depositCents: 1000 }),
    entry('zero', '聚餐', 0, { kind: 'estimate', depositCents: 500 }),
    entry('unclear', '账单', 301),
    entry('void', '已作废项目', 9999, { voided: true }),
    entry('earlier', '范围以外', 123400, { month: '2026-07' }),
  ])
  const prepared = prepareCategorySpending(series)
  assert.equal(prepared.count, 5)
  assert.equal(prepared.amountCents, series.reduce((total, month) => total + month.total, 0))
  const signal = new AbortController().signal
  const rows = await analyzeCategorySpending(prepared, async (titles, receivedSignal) => {
    assert.deepEqual(titles, ['月票', '聚餐', '账单'])
    assert.equal(receivedSignal, signal)
    return ['transport', 'food', 'other']
  }, signal)
  assert.deepEqual(rows, [
    { category: 'transport', amountCents: 1000, count: 2, share: 1000 / 1600 },
    { category: 'other', amountCents: 301, count: 1, share: 301 / 1600 },
    { category: 'food', amountCents: 299, count: 2, share: 299 / 1600 },
  ])
  const january = prepareCategorySpending(series.slice(-1))
  assert.equal(january.count, 4)
  assert.equal(january.amountCents, 1100)
})

test('收到游戏娱乐和周边分类后，与普通购物及其他休闲分别汇总', async () => {
  const input = prepareCategorySpending(statistics([
    entry('top-up-1', '游戏点券充值', 1200),
    entry('top-up-2', '游戏点券充值', 1800),
    entry('stand', '游戏角色亚克力立牌', 2500),
    entry('badge', '动漫角色徽章', 2000),
    entry('cinema', '电影票', 1500),
    entry('shirt', '纯色棉T恤', 1000),
  ]))
  const rows = await analyzeCategorySpending(input, async titles => {
    assert.deepEqual(titles, ['游戏点券充值', '游戏角色亚克力立牌', '动漫角色徽章', '电影票', '纯色棉T恤'])
    return ['gaming', 'merchandise', 'merchandise', 'leisure', 'shopping']
  }, new AbortController().signal)
  assert.deepEqual(rows, [
    { category: 'merchandise', amountCents: 4500, count: 2, share: 0.45 },
    { category: 'gaming', amountCents: 3000, count: 2, share: 0.30 },
    { category: 'leisure', amountCents: 1500, count: 1, share: 0.15 },
    { category: 'shopping', amountCents: 1000, count: 1, share: 0.10 },
  ])
})

test('全额预付明细按零元保留笔数，无法发送的旧名称在本地归为其他', async () => {
  const valid = '🚌'.repeat(120)
  const prepared = prepareCategorySpending(statistics([
    entry('zero', valid, 0, { kind: 'estimate', depositCents: 1000 }),
    entry('long', valid + '🚌', 0), entry('empty', '   ', 0), entry('nul', '测试\0名称', 0),
  ]))
  const signal = new AbortController().signal
  assert.deepEqual(await analyzeCategorySpending(prepared, async titles => {
    assert.deepEqual(titles, [valid])
    return ['transport']
  }, signal), [
    { category: 'other', amountCents: 0, count: 3, share: 0 },
    { category: 'transport', amountCents: 0, count: 1, share: 0 },
  ])
  const empty = prepareCategorySpending(statistics([]))
  assert.deepEqual(await analyzeCategorySpending(empty, () => assert.fail('空区间应跳过请求'), signal), [])
})

test('大量款项按每批四十个名称分类，批次失败或已取消时不产生部分结果', async () => {
  const prepared = prepareCategorySpending(statistics(Array.from({ length: 41 }, (_, i) => entry(i, '名称' + i, i))))
  const signal = new AbortController().signal
  const calls = []
  assert.deepEqual(await analyzeCategorySpending(prepared, async titles => {
    calls.push(titles)
    return titles.map(() => 'shopping')
  }, signal), [{ category: 'shopping', count: 41, amountCents: 820, share: 1 }])
  assert.deepEqual(calls.map(titles => titles.length), [40, 1])
  for (const bad of [[], ['invented'], [null], ['food', 'food'], { amountCents: 100, category: 'food' }]) {
    await assert.rejects(analyzeCategorySpending(prepared, async titles => titles.length === 1 ? bad : titles.map(() => 'food'), signal), /AI_BAD_RESPONSE/)
  }
  const controller = new AbortController()
  let requestCount = 0
  await assert.rejects(analyzeCategorySpending(prepared, async titles => {
    requestCount++
    controller.abort()
    return titles.map(() => 'food')
  }, controller.signal), /AI_CANCELLED/)
  assert.equal(requestCount, 1)
})
