import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { toReminderFacts } from '../src/integrations/ai/capabilities.ts'
import { draftPlatformId, estimateAmountsConflict, readBillDrafts } from '../src/integrations/ai/visionDrafts.ts'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'

test('提醒上下文只提取指定月份的汇总事实', () => {
  const summary = { due: 3250, balance: 10675, salary: 100000, groups: [{ title: '私密款项' }] }
  assert.deepEqual(toReminderFacts('2027-01', summary, 20000), {
    month: '2027-01', dueCents: 3250, balanceCents: 10675, warningFloorCents: 20000,
  })
})

test('识图草稿保留多笔、分期与缺失字段，可处理没有款项的图片', async () => {
  const path = new URL('../resources/ai/fixtures/vision-synthetic.json', import.meta.url)
  const sample = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(readBillDrafts(sample), sample.drafts)
  assert.deepEqual(readBillDrafts({ drafts: [] }), [])
})

test('越界或无法辨认的字段留给审核，不接受模型提供的平台 ID 或还款状态', () => {
  const [draft] = readBillDrafts({ drafts: [{
    platformHint: ' 示例 ', title: '', platformId: 'model-id', status: 'paid',
    month: '2027-13', amountCents: 5.5, kind: 'installment', installmentCount: 0,
  }] })
  assert.deepEqual(draft, {
    platformHint: '示例', title: null, month: null, amountCents: null, kind: 'installment', installmentCount: null,
  })
  assert.throws(() => readBillDrafts({ items: [] }), /drafts/)
  assert.throws(() => readBillDrafts({ drafts: [null] }), /第 1 条/)
})

test('识图草稿优先使用手选的平台 ID，自动识别按截图中的名称匹配', () => {
  const platforms = [{ id: 'card', name: '信用卡' }, { id: 'shop', name: 'Shop' }]
  assert.equal(draftPlatformId(platforms, 'Shop', 'card'), 'card')
  assert.equal(draftPlatformId(platforms, null, 'card'), 'card')
  assert.equal(draftPlatformId(platforms, ' shop '), 'shop')
  assert.equal(draftPlatformId(platforms, 'Shop', 'removed'), 'shop')
  assert.equal(draftPlatformId(platforms, '未知平台'), '')
  assert.equal(draftPlatformId([], null, 'removed'), '')
})

test('待开补款列表逐笔读取卡片的到货补款月份', () => {
  const rows = [
    { title: '合成商品甲', month: '2026.11' },
    { title: '合成商品乙', month: null, repaymentTimeText: '已付定金¥10.00，预计2026.11到货补款' },
    { title: '合成商品丙', month: '2026-11', repaymentTimeText: '预计2026.11到货补款' },
    { title: '次年补款', month: null, repaymentTimeText: '预计2027.01到货补款' },
    { title: '未公布补款时间', month: null },
  ]
  const drafts = readBillDrafts({ drafts: rows.map(row => ({ ...row, kind: 'estimate' })) })
  assert.deepEqual(drafts.map(row => row.month), ['2026-11', '2026-11', '2026-11', '2027-01', null])
})

test('识图金额和其他订单日期不充当还款月份，明确的还款日期按月归一化', () => {
  const month = value => readBillDrafts({ drafts: [{ month: value }] })[0].month
  for (const value of [' 2027-2 ', '2027/2/18', '2027年2月18日', '2027-02-18 12:00:00']) {
    assert.equal(month(value), '2027-02')
  }
  assert.equal(month(2026.11), '2026-11')
  assert.equal(month('2028年2月29日'), '2028-02')
  for (const value of [2026.1, '73.20', '11月', '下月', '2027-02-29', '2027-2-0', '2100.01',
    '预计2026.11到货', '购买日期：2026-11-21', '预计2026.11至2026.12到货补款']) {
    assert.equal(month(value), null, String(value))
  }
})

test('月账单逐行保留本期金额和期号，不展开已有分期，退款去向不改变本期', () => {
  const statementMonthText = '12月总计账单'
  const purchase = { title: '滤纸', amountCents: 1144, repaymentTimeText: '2026-11-11', statementMonthText }
  const period = { kind: 'installment', title: '第2/3期 耳机', amountCents: 6103, installmentCount: 3,
    month: '2027-01', repaymentTimeText: '已退至2027年1月账单', statementMonthText }
  const drafts = readBillDrafts({ drafts: [purchase, purchase, period,
    { ...period, title: '第3/3期 画册', amountCents: 700 }, { ...purchase, title: '退款', amountCents: -500 },
  ] }, '2026-11')
  assert.deepEqual(drafts.map(row => [row.title, row.amountCents, row.month, row.kind, row.installmentCount]), [
    ['滤纸', 1144, '2026-12', 'single', null], ['滤纸', 1144, '2026-12', 'single', null],
    ['第2/3期 耳机', 6103, '2026-12', 'single', null], ['第3/3期 画册', 700, '2026-12', 'single', null],
  ])
  const [withoutHeader] = readBillDrafts({ drafts: [{ kind: 'installment', title: '第１／３期 画册', installmentCount: 3 }] })
  assert.equal(withoutHeader.kind, 'single')
  assert.equal(withoutHeader.installmentCount, null)
})

test('账单缺年时只匹配选中月及相邻月份，跨年和明确的还款日均按日期校验', () => {
  const month = (label, reference) =>
    readBillDrafts({ drafts: [{ statementMonthText: label, month: '2026-11' }] }, reference)[0].month
  assert.equal(month('1月总计账单', '2026-12'), '2027-01')
  assert.equal(month('还款日12月8日', '2027-01'), '2026-12')
  assert.equal(month('账单月份：2028年2月', '2026-11'), '2028-02')
  assert.equal(month('还款日2月29日', '2028-01'), '2028-02')
  assert.equal(month('还款日2月29日', '2027-01'), null)
  assert.equal(month('7月账单', '2026-11'), null)
  assert.equal(month('1月账单'), null)
  assert.equal(month('1月账单', '2099-12'), null)
  assert.equal(month('已退至2027年1月账单', '2026-12'), null)
})

test('截图中的尾款、总价和已付定金独立识别，有两项依据时补全金额', () => {
  const estimate = fields => readBillDrafts({ drafts: [{ kind: 'estimate', ...fields }] })[0]
  const values = draft => [draft.totalCents, draft.depositCents, draft.amountCents]
  assert.deepEqual(values(estimate({ amountCents: 500 })), [null, null, 500])
  assert.deepEqual(values(estimate({ totalCents: 500 })), [500, null, null])
  assert.deepEqual(values(estimate({ depositCents: 100 })), [null, 100, null])
  assert.deepEqual(values(estimate({ amountCents: 0, depositCents: 500 })), [500, 500, 0])
  assert.deepEqual(values(estimate({ amountCents: 400, totalCents: 500 })), [500, 100, 400])
  assert.deepEqual(values(estimate({ amountCents: 500, depositCents: 0 })), [500, 0, 500])
  assert.deepEqual(values(estimate({ totalCents: 500, depositCents: 100 })), [500, 100, null])
  assert.equal(estimateAmountsConflict(estimate({ totalCents: 500, depositCents: 100, amountCents: 400 })), false)
  for (const fields of [
    { amountCents: 420, totalCents: 500, depositCents: 100 },
    { totalCents: 100, depositCents: 150 },
    { totalCents: 100, amountCents: 150 },
    { amountCents: MAX_AMOUNT_CENTS, depositCents: 1 },
  ]) assert.equal(estimateAmountsConflict(estimate(fields)), true)
  for (const kind of ['installment', 'single']) {
    const [draft] = readBillDrafts({ drafts: [{ kind, amountCents: 0, totalCents: 500, depositCents: 100 }] })
    assert.equal(draft.amountCents, null)
    assert.equal(draft.totalCents, undefined)
    assert.equal(draft.depositCents, undefined)
  }
})
