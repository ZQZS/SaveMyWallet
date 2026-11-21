import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_AMOUNT_CENTS } from '../src/domain/ledger.ts'
import { findNoticeCandidates, prepareNoticeReview } from '../src/features/ai/noticeMatch.ts'

const estimate = {
  id: 'order-1', platformId: 'shop', title: '冬日手办', month: '2026-11',
  kind: 'estimate', status: 'estimated', amountCents: 8000, depositCents: 2000,
  installmentIndex: null, installmentCount: null,
}
const ledger = {
  platforms: [{ id: 'shop', name: 'B站会员购' }, { id: 'other', name: '新店' }],
  entries: [
    { ...estimate, id: 'other-name', title: '夏日手办' },
    estimate,
    { ...estimate, id: 'past-estimate', month: '2025-06' },
    { ...estimate, id: 'other-shop', platformId: 'other' },
    { ...estimate, id: 'confirmed', status: 'due' },
    { ...estimate, id: 'paid', status: 'paid' },
    { ...estimate, id: 'void', voided: true },
    { ...estimate, id: 'single', kind: 'single' },
  ],
}
const blank = { title: null, platformHint: null, month: null, totalCents: null, depositCents: null, amountCents: null }

test('商家别名、同名预订和改月通知只推荐候选，其他未确认预订仍可手选', () => {
  const notice = { ...blank, title: '冬日手办 补款', platformHint: 'ＢｉｌｉＢｉｌｉ', month: '2027-01', amountCents: 1111 }
  assert.deepEqual(findNoticeCandidates(ledger, notice).map(row => [row.entry.id, row.matched]), [
    ['order-1', true], ['past-estimate', true], ['other-name', false], ['other-shop', false],
  ])
  const sameTitle = findNoticeCandidates(ledger, { ...blank, title: '冬日' }).filter(row => row.matched)
  assert.deepEqual(sameTitle.map(row => row.entry.id), ['order-1', 'past-estimate', 'other-shop'])
})

test('缺少订单线索、平台或商品不匹配时可手选；金额或月份相同不能单独匹配', () => {
  for (const hints of [{}, { platformHint: '另一家店' }, { title: '春日手办' }, { month: '2026-11', amountCents: 8000 }]) {
    const candidates = findNoticeCandidates(ledger, { ...blank, ...hints })
    assert.equal(candidates.length, 4)
    assert.ok(candidates.every(row => !row.matched))
  }
})

test('尾款通知保留原定金，允许重算总价及跨月，不会修改账本', () => {
  const snapshot = structuredClone(estimate)
  assert.deepEqual(prepareNoticeReview(estimate, { ...blank, amountCents: 10255, month: '2027-01' }), {
    month: '2027-01', totalPrice: '122.55', deposit: '20', conflict: false,
  })
  assert.deepEqual(prepareNoticeReview(estimate, { ...blank, totalCents: 15111, depositCents: 2000 }), {
    month: '', totalPrice: '151.11', deposit: '20', conflict: false,
  })
  assert.equal(prepareNoticeReview(estimate, { ...blank, amountCents: 0 }).totalPrice, '20')
  assert.deepEqual(prepareNoticeReview({ ...estimate, depositCents: undefined }, { ...blank, amountCents: 8000 }), {
    month: '', totalPrice: '80', deposit: '0', conflict: false,
  })
  assert.deepEqual(estimate, snapshot)
})

test('保留缺失字段；遇到金额矛盾、无效分值和总价溢出必须人工补填', () => {
  for (const hints of [
    { amountCents: 8000, totalCents: 10001 }, { depositCents: 0, amountCents: 8000 },
    { depositCents: 2100, totalCents: 10100, amountCents: 8000 }, { totalCents: 1000 },
    { amountCents: -1 }, { amountCents: 10.5 }, { amountCents: MAX_AMOUNT_CENTS },
  ]) {
    assert.deepEqual(prepareNoticeReview(estimate, { ...blank, ...hints }), {
      month: '', totalPrice: '', deposit: '20', conflict: true,
    })
  }
  assert.deepEqual(prepareNoticeReview(estimate, { ...blank, month: '2100-01', depositCents: 2000 }), {
    month: '', totalPrice: '', deposit: '20', conflict: false,
  })
  assert.equal(prepareNoticeReview(estimate, { ...blank, month: '1900-01' }).month, '1900-01')
  assert.equal(prepareNoticeReview(estimate, { ...blank, month: '2099-12' }).month, '2099-12')
})
