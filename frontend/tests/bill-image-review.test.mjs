import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'
import { prepareScreenshotBatch, screenshotPlatformId } from '../src/features/ai/billImageReview.ts'

const platforms = [{ id: 'card', name: '信用卡' }, { id: 'huabei', name: '花呗' }]

function bill(fields = {}, status = 'pending') {
  return {
    draft: { kind: 'single', title: '滤纸', platformHint: null, installmentCount: null,
      month: '2026-12', amountCents: 1144, ...fields },
    status,
  }
}

test('整图的手选平台优先，只有一个已知的平台名称时才自动选中', () => {
  const drafts = (...hints) => hints.map(platformHint => bill({ platformHint }).draft)
  assert.equal(screenshotPlatformId(platforms, drafts('花呗', '信用卡'), 'card'), 'card')
  assert.equal(screenshotPlatformId(platforms, drafts(null, ' 花呗 ', '花呗'), 'removed'), 'huabei')
  for (const hints of [[null], ['未收录的平台'], ['信用卡', '花呗'], ['花呗', '未收录的平台']]) {
    assert.equal(screenshotPlatformId(platforms, drafts(...hints)), '')
  }
  assert.equal(screenshotPlatformId(platforms.slice(0, 1), drafts('花呗')), '')
  const builtInPlatforms = [{ id: 'default-huabei', name: '支付宝花呗' }]
  assert.equal(screenshotPlatformId(builtInPlatforms, drafts('花呗', '支付宝花呗')), 'default-huabei')
  const ambiguous = [...platforms, { id: 'another', name: '花呗' }]
  assert.equal(screenshotPlatformId(ambiguous, drafts('花呗')), '')
})

test('批量只写入待核对草稿，逐月合计只计本期应还并保留在还分期的进度', () => {
  const rows = [
    bill(),
    bill({ kind: 'installment', title: ' 耳机 ', amountCents: 6103, installmentIndex: 2, installmentCount: 3 }),
    bill({ amountCents: null }, 'saved'),
    bill({ month: '2027-01', amountCents: 700 }),
    bill({ month: null }, 'skipped'),
  ]
  const batch = prepareScreenshotBatch(rows, 'huabei')
  assert.equal(batch.pendingCount, 3)
  assert.equal(batch.issues.size, 0)
  assert.deepEqual(batch.inputs.map(input => [input.title, input.platformId, input.amountCents]), [
    ['滤纸', 'huabei', 1144], ['耳机', 'huabei', 6103], ['滤纸', 'huabei', 700],
  ])
  const installment = batch.inputs[1]
  assert.deepEqual([installment.kind, installment.month, installment.installmentIndex, installment.installmentCount],
    ['installment', '2026-12', 2, 3])
  assert.deepEqual(batch.currentPeriods, new Map([['2026-12', 7247], ['2027-01', 700]]))
  const unassigned = prepareScreenshotBatch(rows, '')
  assert.deepEqual(unassigned.inputs, [])
  assert.deepEqual(unassigned.currentPeriods, batch.currentPeriods)
})

test('同名同金额的两行分别保留，结束核对后没有可重复提交的账单', () => {
  const rows = [bill(), bill()]
  const first = prepareScreenshotBatch(rows, 'huabei')
  assert.equal(first.inputs.length, 2)
  assert.deepEqual(first.currentPeriods, new Map([['2026-12', 2288]]))
  rows[0].status = 'saved'
  rows[1].status = 'skipped'
  const completed = prepareScreenshotBatch(rows, 'huabei')
  assert.equal(completed.pendingCount, 0)
  assert.deepEqual(completed.inputs, [])
  assert.equal(completed.currentPeriods.size, 0)
})

test('核对页首总额时计入已保存、跳过和带退款备注的正向消费，每笔分期只取本期金额', () => {
  const rows = [
    bill({ amountCents: 8200, refundText: '有退款，已退至下月账单' }),
    bill({ kind: 'installment', amountCents: 2300, installmentIndex: 2, installmentCount: 6 }),
    bill({ amountCents: 500 }, 'saved'),
    bill({ amountCents: 1200 }, 'skipped'),
  ]
  const batch = prepareScreenshotBatch(rows, 'card', { totalCents: 12200 })
  assert.equal(batch.details.totalCents, 12200)
  assert.equal(batch.differenceCents, 0)
  assert.deepEqual(batch.currentPeriods, new Map([['2026-12', 10500]]))
  assert.deepEqual(batch.inputs.map(input => input.amountCents), [8200, 2300])
  assert.equal(batch.inputs[1].installmentCount, 6)
  assert.equal(batch.inputs[0].refundText, undefined)

  // Comparing only pending items would incorrectly match this header.
  const over = prepareScreenshotBatch(rows, 'card', { totalCents: 10500 })
  assert.equal(over.differenceCents, 1700)
  assert.deepEqual(over.inputs, [])
  const short = prepareScreenshotBatch([rows[0]], 'card', { totalCents: 8201 })
  assert.equal(short.differenceCents, -1)
  assert.deepEqual(short.inputs, [])
})

test('缺金额、不同账期或没有明细时不报已核平，跳过无法核对的行仍不能整图入账', () => {
  for (const [rows, issue] of [
    [[], 'billImage.noStatementItems'],
    [[bill(), bill({ amountCents: null }, 'skipped')], 'billImage.incompleteAmounts'],
    [[bill(), bill({ month: null }, 'saved')], 'billImage.missingPeriod'],
    [[bill(), bill({ month: '2027-01' })], 'billImage.mixedPeriods'],
  ]) {
    const batch = prepareScreenshotBatch(rows, 'card', { totalCents: 1144 })
    assert.deepEqual(batch.details, { totalCents: null, issue })
    assert.equal(batch.differenceCents, null)
    assert.deepEqual(batch.inputs, [])
  }
})

test('单笔也检查页首总额，普通订单可以正常入账，无法读取页首的月账单需逐笔核对', () => {
  const rows = [bill()]
  const missingHeader = prepareScreenshotBatch(rows, 'card', { totalCents: null })
  assert.equal(missingHeader.details.totalCents, 1144)
  assert.equal(missingHeader.differenceCents, null)
  assert.deepEqual(missingHeader.inputs, [])
  assert.equal(prepareScreenshotBatch(rows, 'card', { totalCents: 1144 }).inputs.length, 1)
  assert.equal(prepareScreenshotBatch(rows, 'card').inputs.length, 1)
  const zeroHeader = prepareScreenshotBatch(rows, 'card', { totalCents: 0 })
  assert.equal(zeroHeader.differenceCents, 1144)
  assert.deepEqual(zeroHeader.inputs, [])
})

test('不完整草稿逐笔标记，任一待核对行有问题时整批不提交', () => {
  const invalid = [
    { title: ' ' }, { title: '字'.repeat(121) }, { kind: null }, { month: '2100-01' },
    { amountCents: null }, { amountCents: 0 }, { amountCents: 3.4 }, { amountCents: MAX_AMOUNT_CENTS + 1 },
  ]
  const rows = [bill(), ...invalid.map(fields => bill(fields))]
  for (const platformId of ['huabei', '']) {
    const batch = prepareScreenshotBatch(rows, platformId)
    assert.equal(batch.pendingCount, rows.length)
    assert.equal(batch.issues.has(0), false)
    assert.equal(batch.issues.size, invalid.length)
    for (let index = 1; index < rows.length; index++) assert.ok(batch.issues.get(index))
    assert.deepEqual(batch.inputs, [])
    assert.equal(batch.currentPeriods.size, 0)
  }
})

test('常规新计划从首期开始，正在还款的计划须有有效的当前期和末期月份', () => {
  const plan = { kind: 'installment', installmentCount: 3 }
  const valid = prepareScreenshotBatch([
    bill(plan), bill({ ...plan, month: '2099-12', installmentIndex: 3 }), bill({ ...plan, month: '1900-02', installmentIndex: 2 }),
  ], 'card')
  assert.equal(valid.inputs.length, 3)
  assert.equal(valid.inputs[0].installmentIndex ?? 1, 1)
  assert.equal(valid.inputs[1].installmentIndex, 3)
  assert.equal(valid.inputs[2].installmentIndex, 2)
  for (const progress of [
    { installmentIndex: null }, { installmentIndex: 0 }, { installmentIndex: 4 }, { installmentIndex: 1.5 },
    { installmentCount: null }, { installmentCount: 121 },
    { month: '2099-12', installmentIndex: 2 }, { month: '1900-01', installmentIndex: 2 },
  ]) {
    const batch = prepareScreenshotBatch([bill({ ...plan, ...progress })], 'card')
    assert.ok(batch.issues.get(0))
    assert.deepEqual(batch.inputs, [])
  }
})

test('预计补款按总价扣除定金计入本期，全额预付可录入，缺失或矛盾的金额待逐笔核对', () => {
  const estimate = { kind: 'estimate', totalCents: 5000, amountCents: null }
  const batch = prepareScreenshotBatch([
    bill({ ...estimate, depositCents: 1000 }), bill({ ...estimate, depositCents: 5000 }),
  ], 'card')
  assert.deepEqual(batch.inputs.map(input => [input.totalCents, input.depositCents, input.amountCents]),
    [[5000, 1000, 4000], [5000, 5000, 0]])
  assert.deepEqual(batch.currentPeriods, new Map([['2026-12', 4000]]))
  for (const fields of [
    { depositCents: null }, { depositCents: 6000 }, { depositCents: 1000, amountCents: 3900 },
    { totalCents: null, amountCents: 4000 },
  ]) {
    const invalid = prepareScreenshotBatch([bill({ ...estimate, ...fields })], 'card')
    assert.ok(invalid.issues.get(0))
    assert.deepEqual(invalid.inputs, [])
  }
})
