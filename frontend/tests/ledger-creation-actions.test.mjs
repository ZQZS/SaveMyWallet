import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareCreationAction } from '../src/features/ai/ledgerCreationActions.ts'

const month = '2026-11'
function ledger() {
  return { platforms: [{ id: 'p', name: 'Card' }], entries: [],
    settings: { defaultSalaryCents: 320000, warningFloorCents: 100000 }, salaryOverrides: { [month]: 500000 } }
}
const base = { title: '书桌', platform: 'Card', month }

test('创建分期的预览及写入复用每期金额、首期月份和同一操作 ID', async () => {
  const args = { ...base, kind: 'installment', installmentCount: 3, amountCents: 1550 }
  const plan = prepareCreationAction('create_bill', args, month, ledger())
  assert.match(plan.lines.join(' '), /2027/)
  assert.match(plan.lines.join(' '), /46.5/)
  let actual
  await plan.write({ createBills: async (inputs, id) => { actual = { inputs, id } } }, 'same-op')
  assert.deepEqual(actual, { id: 'same-op', inputs: [{
    title: '书桌', platformId: 'p', month, kind: 'installment', installmentCount: 3, amountCents: 1550,
  }] })
  assert.throws(() => prepareCreationAction('create_bill', { ...args, month: '2099-12' }, month, ledger()))
  assert.throws(() => prepareCreationAction('create_bill', { ...args, installmentCount: 2.2 }, month, ledger()))
  assert.throws(() => prepareCreationAction('create_bill', { ...args, platform: 'Car' }, month, ledger()))
})

test('预计补款用总价减去定金，完全预付也能入账；不接受有冲突的金额', async () => {
  const args = { ...base, kind: 'estimate', totalCents: 5000, depositCents: 5000 }
  const plan = prepareCreationAction('create_bill', args, month, ledger())
  let saved
  await plan.write({ createBills: async ([input]) => { saved = input } }, 'estimate')
  assert.equal(saved.amountCents, 0)
  assert.equal(saved.depositCents, 5000)
  assert.equal(saved.totalCents, 5000)
  for (const patch of [{ amountCents: 5000 }, { depositCents: 5001 }, { totalCents: 1.1 }, { installmentCount: 2 }]) {
    assert.throws(() => prepareCreationAction('create_bill', { ...args, ...patch }, month, ledger()))
  }
})

test('新增平台拒绝同名或空名；新增账单仅在目标平台或同类记录发生变化时失效', async () => {
  const data = ledger()
  const plan = prepareCreationAction('create_platform', { name: ' 新平台 ' }, month, data)
  let saved
  await plan.write({ createPlatform: async name => { saved = name; return 'new' } }, 'platform')
  assert.equal(saved, '新平台')
  for (const name of [' card ', ' ', 'a'.repeat(41)]) {
    assert.throws(() => prepareCreationAction('create_platform', { name }, month, data))
  }
  const args = { ...base, kind: 'single', amountCents: 1500 }
  const first = prepareCreationAction('create_bill', args, month, data)
  data.entries.push({ ...args, title: '书柜', platformId: 'p', id: 'other' })
  assert.equal(prepareCreationAction('create_bill', args, month, data).fingerprint, first.fingerprint)
  data.entries.push({ ...args, platformId: 'p', id: 'match' })
  const duplicate = prepareCreationAction('create_bill', args, month, data)
  assert.notEqual(duplicate.fingerprint, first.fingerprint)
  assert.equal(duplicate.lines.length, first.lines.length + 1)
})

test('预算补丁支持零与清除覆盖，保留其他字段的最新值并检测授权字段变化', async () => {
  const data = ledger()
  const patch = { overrideSalaryCents: null, warningFloorCents: 0 }
  const initial = prepareCreationAction('update_budget', patch, month, data)
  data.settings.defaultSalaryCents = 620000
  const current = prepareCreationAction('update_budget', patch, month, data)
  assert.equal(current.fingerprint, initial.fingerprint)
  let saved
  await current.write({ saveBudget: async input => { saved = input } }, 'budget')
  assert.deepEqual(saved, { month, defaultSalaryCents: 620000, warningFloorCents: 0, overrideSalaryCents: null })
  data.salaryOverrides[month] = 0
  assert.notEqual(prepareCreationAction('update_budget', patch, month, data).fingerprint, initial.fingerprint)
  for (const invalid of [{}, { month }, { month: null, overrideSalaryCents: 0 }, { defaultSalaryCents: null },
    { warningFloorCents: -1 }, { warningFloorCents: 1.2 }, { month: '2500-01', overrideSalaryCents: null }]) {
    assert.throws(() => prepareCreationAction('update_budget', invalid, month, data))
  }
})
