import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { toReminderFacts } from '../src/integrations/ai/capabilities.ts'
import { draftPlatformId, estimateAmountsConflict, readBillDrafts, readBillRecognition } from '../src/integrations/ai/visionDrafts.ts'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'

test('账单页首合计独立于明细与订单总价，并区分零和未识别', () => {
  const row = { statementMonthText: '3月账单', amountCents: 550, title: '合成消费' }
  const read = statementTotalCents => readBillRecognition({ drafts: [row], statementTotalCents }, '2027-03')
  assert.equal(read(900).statementTotalCents, 900)
  assert.equal(read(0).statementTotalCents, 0)
  for (const invalid of [undefined, null, '550', -1, 5.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = read(invalid)
    assert.equal(result.statementTotalCents, null)
    assert.equal(result.isMonthlyStatement, true)
  }
  const order = readBillRecognition({ drafts: [{ totalCents: 1200, kind: 'estimate' }] })
  assert.equal(order.isMonthlyStatement, false)
  assert.equal(order.statementTotalCents, null)
})

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
  const huabei = { id: 'huabei', name: '支付宝花呗' }
  assert.equal(draftPlatformId([huabei], '花呗'), 'huabei')
  assert.equal(draftPlatformId([huabei], '花呗分期'), 'huabei')
  assert.equal(draftPlatformId([huabei, { id: 'other', name: '花呗分期' }], '花呗'), '')
  assert.equal(draftPlatformId([huabei, { id: 'other', name: huabei.name }], huabei.name), '')
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

test('花呗月账单按右侧应还金额合计每笔消费，带跨期退款备注的分期保留真实期数', () => {
  const statementMonthText = '12月总计账单'
  const amounts = Array.from({ length: 34 }, (_, i) => i < 2 ? 550 : 1500 + i * 25)
  const rows = amounts.map((amountCents, i) => ({
    title: i < 2 ? '普通消费' : `第2/3期 示例商品${i}`, statementMonthText, amountCents,
  }))
  rows[3].title = '第2/3期 花呗分期 示例商品'
  rows[4].refundText = '有退款，已退至2027年1月账单'
  rows[4].isRefunded = true
  const drafts = readBillDrafts({ drafts: [...rows,
    { title: '退款到账', amountCents: 125, statementMonthText },
    { title: '示例商品4', amountCents: -125, statementMonthText },
  ], filterText: '有退款' }, '2026-11')
  assert.equal(drafts.length, 34)
  assert.equal(drafts.filter(row => row.kind === 'installment').length, 32)
  assert.deepEqual(drafts.map(row => row.amountCents), amounts)
  assert.equal(drafts.reduce((total, row) => total + row.amountCents, 0), 63100)
  assert.deepEqual(drafts.filter(row => row.refundText).map(row => [row.title, row.refundText]), [
    ['示例商品4', '有退款，已退至2027年1月账单'],
  ])
  assert.ok(drafts.every(row => row.platformHint === '花呗' && row.month === '2026-12'))
  assert.ok(drafts.slice(2).every(row => row.installmentIndex === 2 && row.installmentCount === 3))
})

test('账单期数支持标题与结构化字段，保留商品原名，整笔分期和当期期号缺失可区分', () => {
  const drafts = readBillDrafts({ drafts: [
    { title: '第１／３期 画册Ａ', kind: 'single', month: '2026-12' },
    { title: '墨水', kind: 'installment', installmentCount: 3, installmentIndex: 3, month: '2026-12' },
    { title: '第2期 相册', kind: 'installment', installmentCount: 3, month: '2026-12' },
    { title: '第２／３期 画框', installmentIndex: 1, installmentCount: 6 },
    { title: '第４／３期 画板' }, { title: '第2/121期 墨水' },
    { title: '末期明细', kind: 'installment', installmentCount: 3, statementMonthText: '12月账单' },
    { title: '花呗分期 第2/3期 色卡' }, { title: '普通消费', kind: 'single', installmentCount: 1 },
  ] }, '2026-11')
  assert.deepEqual(drafts.map(row => [row.title, row.kind, row.installmentIndex, row.installmentCount]), [
    ['画册Ａ', 'installment', 1, 3], ['墨水', 'installment', 3, 3], ['相册', 'installment', 2, 3],
    ['画框', 'installment', null, null], ['画板', 'installment', null, 3], ['墨水', 'installment', 2, null],
    ['末期明细', 'installment', null, 3],
    ['色卡', 'installment', 2, 3], ['普通消费', 'single', undefined, null],
  ])
  assert.ok(drafts.every(row => row.month === '2026-12'))
  const [plan] = readBillDrafts({ drafts: [
    { title: '平板', kind: 'installment', installmentCount: 6, repaymentTimeText: '首期还款：2027-01' },
  ] })
  assert.equal(plan.month, '2027-01')
  assert.equal(plan.installmentIndex, undefined)
  assert.equal(plan.installmentCount, 6)
  const period = { title: '第2/3期 相册', repaymentTimeText: '首期还款：2026-11' }
  const noHeader = readBillDrafts({ drafts: [period, { ...period, month: '2026-12' }] })
  assert.deepEqual(noHeader.map(row => row.month), [null, '2026-12'])
})

test('独立退款与负金额抵扣排除，正金额消费保留自己的退款备注', () => {
  const row = { title: '明细', amountCents: 500, statementMonthText: '2026年12月' }
  const drafts = readBillDrafts({ filterText: '有退款', drafts: [
    { ...row, refundText: '有退款' }, { ...row, refundText: '已退款' }, { ...row, isRefunded: true },
    { ...row, refundText: '退款到其他月份账单' }, { ...row, title: '商品（已退款）' },
    { ...row, title: '退款至支付宝' }, { ...row, refundText: '已退回花呗余额' },
    { ...row, title: '退款' }, { ...row, title: '第2/3期 退款' }, { ...row, title: '抵扣', amountCents: -300 },
    { ...row, title: '订单退款：普通消费' }, { ...row, title: '已退至2027年1月账单' },
    { ...row, title: '退款成功' }, { ...row, title: '有退款，已退至下月账单' },
    { ...row, title: '第2/3期 有退款 示例画册' },
    { ...row, title: '保留', refundText: '没有退款' }, { ...row, title: '可退款的门票' },
  ] })
  assert.deepEqual(drafts.map(({ title, refundText }) => [title, refundText]), [
    ['明细', '有退款'], ['明细', '已退款'], ['明细', undefined], ['明细', '退款到其他月份账单'],
    ['商品（已退款）', undefined], ['明细', '已退回花呗余额'],
    ['有退款 示例画册', undefined], ['保留', '没有退款'], ['可退款的门票', undefined],
  ])
  assert.ok(drafts.every(draft => draft.amountCents === 500 && draft.month === '2026-12'))
})

test('裁掉账单页头时退款去向不推算本期月份，负数不转成正债务', () => {
  const memo = '有退款，已退至2027年1月账单'
  const drafts = readBillDrafts({ drafts: [
    { title: '第2/3期 合成商品', amountCents: 320, repaymentTimeText: memo, refundText: memo },
    { title: '合成商品负向调整', amountCents: -20 },
  ] }, '2026-12', '花呗')
  assert.deepEqual(drafts.map(({ title, month, amountCents, installmentIndex, installmentCount, refundText }) =>
    [title, month, amountCents, installmentIndex, installmentCount, refundText]), [
    ['合成商品', null, 320, 2, 3, memo],
  ])
  assert.deepEqual(readBillDrafts({ drafts: [{ title: '调整', amountCents: -80 }] }), [])
  const unsignedCharge = { title: '合成商品', amountCents: 320, refundText: memo }
  const [charge] = readBillDrafts({ statementTotalCents: 320, drafts: [unsignedCharge] })
  assert.deepEqual([charge.kind, charge.amountCents, charge.month, charge.refundText], ['single', 320, null, memo])
})

test('已取消退款的预计补款和完整分期方案不会生成待还项目', () => {
  const base = { title: '合成商品', amountCents: 320, platformHint: '花呗', refundText: '已退款' }
  assert.deepEqual(readBillDrafts({ drafts: [
    { ...base, kind: 'estimate' }, { ...base, kind: 'installment', installmentCount: 3 },
  ] }), [])
})

test('缺少页头的花呗截图保留单独标出的本期序号，其他平台商品可叫第2期', () => {
  const row = { title: '第2期 商品', kind: 'single', amountCents: 500 }
  const read = (rows, selectedPlatform) => readBillDrafts({ drafts: rows }, undefined, selectedPlatform)
    .map(({ title, kind, installmentIndex, installmentCount }) => [title, kind, installmentIndex, installmentCount])
  const period = ['商品', 'installment', 2, null]
  const single = ['第2期 商品', 'single', undefined, null]
  assert.deepEqual(read([{ ...row, platformHint: '支付宝花呗' }]), [period])
  assert.deepEqual(read([row], '支付宝花呗'), [period])
  assert.deepEqual(read([{ ...row, platformHint: '支付宝' }], '支付宝花呗'), [period])
  assert.deepEqual(read([{ ...row, platformHint: '玩具店' }], '支付宝花呗'), [single])
  assert.deepEqual(read([{ ...row, platformHint: '玩具店' }]), [single])
  assert.deepEqual(read([{ ...row, platformHint: '玩具店', statementMonthText: '12月账单' }]), [single])
  assert.deepEqual(read([{ ...row, platformHint: '花呗' }, { ...row, platformHint: '玩具店' }]), [period, single])
  assert.deepEqual(read([row, { ...row, title: '普通消费', platformHint: '花呗分期' }])[0], period)
})

test('同页多个平台时只使用本行的平台证据', () => {
  const rows = ['支付宝花呗', null, '京东白条'].map(platformHint => ({
    title: '消费', statementMonthText: '12月账单', platformHint,
  }))
  assert.deepEqual(readBillDrafts({ drafts: rows }).map(draft => draft.platformHint), ['支付宝花呗', null, '京东白条'])
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
  for (const fields of [
    { totalCents: -1, depositCents: 100, amountCents: 400 },
    { totalCents: 500, depositCents: 2.5, amountCents: 400 },
    { totalCents: 500, depositCents: 100, amountCents: MAX_AMOUNT_CENTS + 1 },
  ]) assert.equal(estimateAmountsConflict(estimate(fields)), true)
  for (const kind of ['installment', 'single']) {
    const [draft] = readBillDrafts({ drafts: [{ kind, amountCents: 0, totalCents: 500, depositCents: 100 }] })
    assert.equal(draft.amountCents, null)
    assert.equal(draft.totalCents, undefined)
    assert.equal(draft.depositCents, undefined)
  }
})
