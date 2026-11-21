import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'
import { findStatementMatches, prepareScreenshotBatch, screenshotPlatformId } from '../src/features/ai/billImageReview.ts'

const platforms = [{ id: 'card', name: '信用卡' }, { id: 'huabei', name: '花呗' }]
const [card, huabei] = platforms

function matchContext(platform, overrides = {}) {
  return { platform, batchPlatformId: platform.id, monthlyStatement: true, ...overrides }
}

function bill(fields = {}, status = 'pending') {
  return {
    draft: { kind: 'single', title: '滤纸', platformHint: null, installmentCount: null,
      month: '2026-12', amountCents: 1144, ...fields },
    status,
  }
}

function entry(id, fields = {}) {
  return { id, platformId: 'huabei', title: '滤纸', kind: 'single', month: '2026-12', amountCents: 1144,
    status: 'due', installmentIndex: null, installmentCount: null, ...fields }
}

test('重拍月账单按已有笔数逐笔匹配，新同名消费保留并计入整图核对', () => {
  const rows = [bill({ title: ' 滤纸 ' }), bill(), bill({ title: '牛奶' }), bill({ title: '书' })]
  const existing = [entry('paid', { status: 'paid' }), entry('milk', { title: '牛奶' })]
  const matched = findStatementMatches(rows, existing, matchContext(huabei))
  assert.deepEqual([...matched], [[0, existing[0]], [2, existing[1]]])
  const header = { totalCents: 4576 }
  const batch = prepareScreenshotBatch(rows, 'huabei', header, matched)
  assert.equal(batch.details.totalCents, 4576)
  assert.equal(batch.differenceCents, 0)
  assert.equal(batch.pendingCount, 2)
  assert.deepEqual(batch.pendingIndices, [1, 3])
  assert.deepEqual(batch.inputs.map(i => i.title), ['滤纸', '书'])
  assert.deepEqual(batch.currentPeriods, new Map([['2026-12', 2288]]))
  assert.deepEqual(prepareScreenshotBatch(rows, 'huabei', { totalCents: 2288 }, matched).inputs, [])
  rows[1].status = 'skipped'
  assert.deepEqual(prepareScreenshotBatch(rows, 'huabei', header, findStatementMatches(rows, existing, matchContext(huabei))).pendingIndices, [3])
  rows[3].status = 'saved'
  const finished = prepareScreenshotBatch(rows, 'huabei', header, matched)
  assert.deepEqual(finished.pendingIndices, [])
  assert.equal(finished.differenceCents, 0)

  const updated = [...existing, entry('new-filter'), entry('new-book', { title: '书' })]
  const nextScreenshot = rows.map(({ draft }) => ({ draft, status: 'pending' }))
  const fullMatch = findStatementMatches(nextScreenshot, updated, matchContext(huabei))
  assert.deepEqual([...fullMatch.values()].map(e => e.id), ['paid', 'new-filter', 'milk', 'new-book'])
  const repeated = prepareScreenshotBatch(nextScreenshot, 'huabei', header, fullMatch)
  assert.deepEqual(repeated.inputs, [])
  assert.equal(repeated.differenceCents, 0)
})

test('月账单仅匹配同平台同账期有效明细，分期还须当前序号及总期数一致', () => {
  const period = { kind: 'installment', installmentIndex: 2, installmentCount: 3 }
  const existing = [
    entry('void', { voided: true }), entry('otherPlatform', { platformId: 'card' }), entry('lastMonth', { month: '2026-11' }),
    entry('differentAmount', { amountCents: 1143 }), entry('differentTitle', { title: '滤 纸' }),
    entry('estimate', { kind: 'estimate', status: 'estimated' }), entry('plan', period),
  ]
  const rows = [
    bill(), bill({ ...period, installmentIndex: 1 }), bill({ ...period, installmentIndex: null }),
    bill({ ...period, installmentIndex: undefined }), bill({ ...period, installmentCount: null }),
    bill({ ...period, installmentCount: 4 }), bill({ ...period, refundText: '有退款，已退至下月账单' }),
    bill(period), bill({ kind: 'estimate', totalCents: 1144, depositCents: 0 }),
    bill({ title: null }), bill({ kind: null }), bill({ amountCents: null }), bill({ month: null }),
  ]
  assert.deepEqual([...findStatementMatches(rows, existing, matchContext(huabei))], [[6, existing[6]]])
  assert.deepEqual([...findStatementMatches(rows, existing, matchContext(card))], [[0, existing[1]]])
  assert.equal(findStatementMatches(rows, existing, { batchPlatformId: '', monthlyStatement: true }).size, 0)
})

test('改正识别的名称与金额后，跳过旧账与确认为新消费会留下不同的待入账明细', () => {
  const rows = [bill({ title: '识别错字', amountCents: 14 }), bill()]
  const existing = [entry('old')]
  const context = matchContext(huabei)
  const [corrected] = prepareScreenshotBatch([bill()], huabei.id).inputs
  assert.deepEqual([...findStatementMatches(rows, existing, context)], [[1, existing[0]]])
  const editing = findStatementMatches(rows, existing, { ...context, edit: { index: 0, input: corrected } })
  assert.deepEqual([...editing], [[0, existing[0]]])

  rows[0] = { draft: { ...rows[0].draft, ...corrected }, status: 'skipped',
    skippedReview: { platformId: huabei.id, matchId: editing.get(0).id } }
  const skipped = prepareScreenshotBatch(rows, huabei.id, { totalCents: 2288 }, findStatementMatches(rows, existing, context))
  assert.equal(skipped.differenceCents, 0)
  assert.deepEqual(skipped.pendingIndices, [1])
  assert.equal(skipped.inputs.length, 1)

  rows[0] = { draft: rows[0].draft, status: 'saved' }
  const afterSavingNew = findStatementMatches(rows, existing, context)
  assert.deepEqual([...afterSavingNew], [[1, existing[0]]])
  assert.deepEqual(prepareScreenshotBatch(rows, huabei.id, { totalCents: 2288 }, afterSavingNew).pendingIndices, [])
})

test('手工跳过只保留明确关联的原账，切换平台后可匹配那个平台的同名消费', () => {
  const existing = [entry('first'), entry('second'), entry('other', { platformId: card.id })]
  const rows = [bill({}, 'skipped'), bill(), bill()]
  rows[0].skippedReview = { platformId: huabei.id, matchId: 'second' }
  assert.deepEqual([...findStatementMatches(rows, existing, matchContext(huabei))], [[1, existing[0]]])
  assert.deepEqual([...findStatementMatches(rows, existing, matchContext(card))], [[1, existing[2]]])

  const [onCard] = prepareScreenshotBatch([rows[2]], card.id).inputs
  const editDifferentPlatform = matchContext(card, { batchPlatformId: huabei.id, edit: { index: 2, input: onCard } })
  assert.deepEqual([...findStatementMatches(rows, existing, editDifferentPlatform)], [[2, existing[2]]])

  rows[0].skippedReview = { platformId: huabei.id }
  assert.deepEqual([...findStatementMatches(rows, existing, matchContext(huabei))], [[1, existing[0]], [2, existing[1]]])
})

test('重新核对先前已跳过的一笔时，同名的在前行无法抢占已确认的原账', () => {
  const existing = [entry('old')]
  const rows = [bill(), { ...bill({}, 'skipped'), skippedReview: { platformId: huabei.id, matchId: 'old' } }]
  const [input] = prepareScreenshotBatch([bill()], huabei.id).inputs
  const reopened = findStatementMatches(rows, existing, matchContext(huabei, { edit: { index: 1, input } }))
  assert.deepEqual([...reopened], [[1, existing[0]]])
  const renamed = findStatementMatches(rows, existing, matchContext(huabei, { edit: { index: 1, input: { ...input, title: '书' } } }))
  assert.deepEqual([...renamed], [[0, existing[0]]])
})

test('支付宝裁剪图缺少页首时仍按平台或行内提示比对，其他平台的普通订单继续逐笔入账', () => {
  const alipay = { id: 'alipay', name: '支付宝' }
  const existing = [entry('alipay-line', { platformId: alipay.id }), entry('card-line', { platformId: card.id })]
  const cropped = { monthlyStatement: false }
  assert.deepEqual([...findStatementMatches([bill()], existing, matchContext(alipay, cropped))], [[0, existing[0]]])
  assert.deepEqual([...findStatementMatches([bill()], existing, matchContext(card, cropped))], [])
  for (const platformHint of ['支付宝', '花呗']) {
    assert.deepEqual([...findStatementMatches([bill({ platformHint })], existing, matchContext(card, cropped))], [[0, existing[1]]])
  }
})

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

test('批量入账按勾选行的原顺序保存，未勾选的明细可在同次核对中继续入账', () => {
  const rows = [
    bill({ amountCents: 100 }), bill({ title: '苹果', amountCents: 1200 }),
    bill({ amountCents: 500 }, 'skipped'), bill({ amountCents: 700 }, 'saved'),
    bill({ title: '香蕉', amountCents: 300 }), bill({ title: '葡萄', amountCents: 600 }),
  ]
  const matches = findStatementMatches(rows, [entry('old', { amountCents: 100 })], matchContext(huabei))
  const header = { totalCents: 3400 }
  const eligible = [1, 4, 5]
  const empty = prepareScreenshotBatch(rows, huabei.id, header, matches, new Set())
  assert.deepEqual(empty.eligibleIndices, eligible)
  assert.deepEqual(empty.pendingIndices, [])
  assert.equal(empty.pendingCount, 0)
  assert.deepEqual(empty.inputs, [])
  assert.equal(empty.currentPeriods.size, 0)
  assert.equal(empty.differenceCents, 0)
  const all = prepareScreenshotBatch(rows, huabei.id, header, matches, new Set(rows.keys()))
  assert.deepEqual(all, prepareScreenshotBatch(rows, huabei.id, header, matches))
  assert.deepEqual(all.pendingIndices, eligible)

  const subset = new Set([5, 3, 2, 1, 0, 99])
  const first = prepareScreenshotBatch(rows, huabei.id, header, matches, subset)
  assert.deepEqual(first.eligibleIndices, eligible)
  assert.deepEqual(first.pendingIndices, [1, 5])
  assert.equal(first.pendingCount, 2)
  assert.deepEqual(first.inputs.map(input => input.title), ['苹果', '葡萄'])
  assert.deepEqual(first.currentPeriods, new Map([['2026-12', 1800]]))
  assert.equal(first.details.totalCents, 3400)
  assert.equal(first.differenceCents, 0)
  const partialHeader = prepareScreenshotBatch(rows, huabei.id, { totalCents: 1800 }, matches, subset)
  assert.equal(partialHeader.differenceCents, 1600)
  assert.deepEqual(partialHeader.inputs, [])

  for (const index of first.pendingIndices) rows[index].status = 'saved'
  const next = prepareScreenshotBatch(rows, huabei.id, header, matches, new Set([1, 4, 5]))
  assert.deepEqual(next.eligibleIndices, [4])
  assert.deepEqual(next.pendingIndices, [4])
  assert.deepEqual(next.inputs.map(input => input.title), ['香蕉'])
  assert.equal(next.differenceCents, 0)
})

test('勾选有效行可先入账，整图核平仍要求每笔本期金额和还款月有效', () => {
  const rows = [bill(), bill({ title: '' }), bill({ kind: 'installment', installmentIndex: null, installmentCount: 3 })]
  const header = { totalCents: 3432 }
  const selectFirst = new Set([0])
  const first = prepareScreenshotBatch(rows, card.id, header, undefined, selectFirst)
  assert.deepEqual(first.eligibleIndices, [0, 1, 2])
  assert.equal(first.inputs.length, 1)
  assert.equal(first.issues.size, 0)
  const withInvalid = prepareScreenshotBatch(rows, card.id, header, undefined, new Set([0, 2]))
  assert.deepEqual([...withInvalid.issues], [[2, 'forms.reviewScheduleError']])
  assert.deepEqual(withInvalid.inputs, [])
  for (const [fields, issue] of [
    [{ amountCents: null }, 'billImage.incompleteAmounts'], [{ month: null }, 'billImage.missingPeriod'],
  ]) {
    const incomplete = [bill(), bill(fields)]
    const monthly = prepareScreenshotBatch(incomplete, card.id, header, undefined, selectFirst)
    assert.equal(monthly.details.issue, issue)
    assert.deepEqual(monthly.inputs, [])
    const ordinary = prepareScreenshotBatch(incomplete, card.id, null, undefined, selectFirst)
    assert.equal(ordinary.inputs.length, 1)
  }
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
