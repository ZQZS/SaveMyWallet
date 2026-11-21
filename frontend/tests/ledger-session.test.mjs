import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { buildStatistics } from '../src/features/statistics/statistics.ts'

test('自然月变化会更新账单和统计，浏览其他月份不会触发顺延', async () => {
  const original = { id: 'balance', platformId: 'store', title: '预订尾款', month: '2026-12',
    kind: 'estimate', status: 'estimated', amountCents: 8000, depositCents: 2000,
    installmentIndex: null, installmentCount: null }
  const snapshot = { platforms: [{ id: 'store', name: '商店' }], entries: [original],
    settings: { defaultSalaryCents: 30000, warningFloorCents: 0 }, salaryOverrides: {} }
  const session = createLedgerSession({ repository: { load: async () => snapshot }, calculateMonth: summarize })
  session.updateCalendarMonth('2026-12', false)
  await session.retryRead()
  session.selectMonth('2027-02')
  assert.equal(session.data.value.entries[0].month, '2026-12')
  session.selectMonth('2026-12')
  session.updateCalendarMonth('2027-01', true)
  assert.equal(session.month.value, '2027-01')
  assert.deepEqual(buildStatistics(session.data.value, '2026-12', '2027-02').map(p => [p.estimated, p.balance]),
    [[0, 30000], [8000, 22000], [0, 30000]])
  session.selectMonth('2026-12')
  session.updateCalendarMonth('2027-02', true)
  await session.retryRead()
  assert.equal(session.month.value, '2026-12')
  assert.equal(session.data.value.entries[0].month, '2027-02')
  assert.equal(session.data.value.entries[0].carriedFromMonth, '2026-12')
  assert.equal(original.month, '2026-12')
  assert.equal(session.writeCount.value, 0)
})

test('写入后读取失败，再次读取不会重复写入或重复执行完成回调', async () => {
  const snapshot = {
    platforms: [{ id: 'new-id', name: '新平台' }], entries: [],
    settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {},
  }
  let reads = 0
  let writes = 0
  const repository = {
    async load() {
      if (++reads === 1) throw new Error('暂时无法读取')
      return snapshot
    },
    async createPlatform() { writes++; return 'new-id' },
  }
  const session = createLedgerSession({ repository, calculateMonth: summarize })
  const selections = []
  const submit = () => session.commit(() => repository.createPlatform(), id => {
    assert.equal(session.busy.value, false)
    assert.equal(session.data.value, snapshot)
    selections.push(id)
  })

  await submit()
  assert.equal(session.needsReload.value, true)
  assert.deepEqual(selections, [])
  await submit()
  await session.retryRead()
  await session.retryRead()
  assert.equal(session.needsReload.value, false)
  assert.equal(writes, 1)
  assert.equal(reads, 3)
  assert.deepEqual(selections, ['new-id'])
})
