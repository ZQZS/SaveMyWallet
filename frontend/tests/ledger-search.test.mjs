import assert from 'node:assert/strict'
import test from 'node:test'
import { searchLedger } from '../src/features/ai/ledgerSearch.ts'

const active = {
  title: null, platform: null, kind: null, statuses: [], fromMonth: null, toMonth: null,
  hasDeposit: null, outstandingOnly: false, voided: 'active',
}
const base = {
  platformId: 'shop', title: '模型', month: '2026-12', kind: 'estimate', status: 'estimated',
  installmentIndex: null, installmentCount: null,
}
const ledger = {
  platforms: [{ id: 'shop', name: 'B站会员购' }, { id: 'credit', name: '白条' }],
  entries: [
    { ...base, id: 'next', amountCents: 3003, depositCents: 1000, month: '2027-01', status: 'due' },
    { ...base, id: 'old', amountCents: 404, month: '2025-01' },
    { ...base, id: 'unconfirmed', title: 'ＡＢ 夏日模型', amountCents: 2002, depositCents: 300 },
    { ...base, id: 'settled', amountCents: 1001, depositCents: 200, status: 'paid' },
    { ...base, id: 'prepaid', amountCents: 0, depositCents: 5000 },
    { ...base, id: 'void', amountCents: 2222, depositCents: 500, voided: true },
    { ...base, id: 'split', kind: 'installment', amountCents: 7007, status: 'due', platformId: 'credit' },
    { ...base, id: 'ordinary', kind: 'single', amountCents: 808, status: 'paid', platformId: 'credit' },
  ],
}
const run = conditions => searchLedger(ledger, { ...active, ...conditions })
const ids = result => result.entries.map(entry => entry.id)

test('组合查付过定金且仍要补钱的预订，含起讫月份，仅计算实际尾款', () => {
  const original = structuredClone(ledger)
  const result = run({
    kind: 'estimate', platform: 'bilibili', hasDeposit: true, outstandingOnly: true,
    fromMonth: '2026-12', toMonth: '2027-01',
  })
  assert.deepEqual(ids(result), ['unconfirmed', 'next'])
  assert.deepEqual([result.estimated, result.due, result.paid, result.total], [2002, 3003, 0, 5005])
  assert.deepEqual(ledger, original)
})

test('月份支持单边、标题可规范化、平台可用简称，状态和类型联合筛选', () => {
  assert.deepEqual(ids(run({ fromMonth: '2027-01' })), ['next'])
  assert.deepEqual(ids(run({ toMonth: '2025-01' })), ['old'])
  assert.deepEqual(ids(run({ title: 'ab 夏日' })), ['unconfirmed'])
  assert.deepEqual(ids(run({ platform: 'JD白条', kind: 'installment', statuses: ['due', 'paid'] })), ['split'])
  assert.deepEqual(ids(run({ kind: 'estimate', statuses: ['due', 'paid'] })), ['settled', 'next'])
  assert.deepEqual(ids(run({ hasDeposit: false })), ['old'])
})

test('明确包括或只查作废时保留原明细，有效合计排除作废项', () => {
  const result = run({ voided: 'all' })
  assert.equal(result.entries.length, 8)
  assert.deepEqual([result.estimated, result.due, result.paid, result.total], [2406, 10010, 1809, 14225])
  const voided = run({ voided: 'voided' })
  assert.deepEqual(ids(voided), ['void'])
  assert.equal(voided.total, 0)
  assert.deepEqual(ids(run({ voided: 'voided', outstandingOnly: true })), [])
  assert.deepEqual(ids(run({ platform: '哔哩哔哩', statuses: ['paid'] })), ['settled'])
})

test('没有命中是空清单；无筛选条件、不能表达或无效的条件返回 null', () => {
  for (const conditions of [{ platform: '新平台' }, { title: '不存在' }, { fromMonth: '2099-12' }, { toMonth: '1900-01' }]) {
    assert.deepEqual(run(conditions), { entries: [], estimated: 0, due: 0, paid: 0, total: 0 })
  }
  for (const conditions of [
    {}, { platform: '  ' }, { supported: false, voided: 'all' }, { supported: false, title: '模型' },
    { fromMonth: '2027-01', toMonth: '2026-12' }, { fromMonth: '1899-12' }, { toMonth: '2100-01' },
    { voided: 'invalid' }, { statuses: ['due', 'invalid'] }, { platform: {} },
    { title: 10 }, { outstandingOnly: 'true' }, { hasDeposit: undefined }, { supported: 'false', voided: 'all' },
  ]) {
    assert.equal(run(conditions), null)
  }
})
