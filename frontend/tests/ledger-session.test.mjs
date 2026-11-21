import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { buildStatistics } from '../src/features/statistics/statistics.ts'
import { formatMoney, t } from '../src/i18n/index.ts'

test('撤销 AI 改账后仍能撤销独立的手动还款，刷新重试只更新仍可用的记录', async () => {
  const month = '2026-11'
  const ledger = { entries: ['manual', 'changed', 'removed', 'voided'].map(id => ({
    id, month, title: id, kind: 'single', platformId: 'p', status: 'paid', amountCents: 100,
  })), platforms: [], settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {} }
  let failRead = false
  const calls = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {
    async load() { if (failRead) throw Error('read failed'); return structuredClone(ledger) },
    async undoPayment(ids, paid) { calls.push([ids, paid]); return ids },
  } })
  session.lastPayment.value = { month, ids: ledger.entries.map(entry => entry.id), paid: true }
  await session.retryRead()
  await session.commit(async () => {
    ledger.entries.find(e => e.id === 'changed').status = 'due'
    ledger.entries.find(e => e.id === 'voided').voided = true
    ledger.entries = ledger.entries.filter(e => e.id !== 'removed')
    failRead = true
  }, session.reconcilePaymentUndo)
  assert.equal(session.needsReload.value, true)
  failRead = false
  await session.retryRead()
  assert.deepEqual(session.lastPayment.value, { month, ids: ['manual'], paid: true })
  await session.undoPayment()
  assert.deepEqual(calls, [[['manual'], false]])
})

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

test('平台跨月还款按实际变更的金额和笔数提示，作废一笔后仍可撤销其余还款', async () => {
  const snapshot = {
    platforms: [{ id: 'shop', name: '商店' }],
    entries: [
      { id: 'one', month: '2026-12', amountCents: 12345 },
      { id: 'two', month: '2027-01', amountCents: 8766 },
      { id: 'unchanged', month: '2026-12', amountCents: 90000 },
    ].map(entry => ({ ...entry, kind: 'single', status: 'paid', platformId: 'shop' })),
    settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {},
  }
  const writes = [], undos = [], saved = []
  let canRead = false
  const session = createLedgerSession({
    repository: {
      async load() { if (!canRead) throw Error('暂时无法读取'); return snapshot },
      async setPayment(ids, paid) {
        writes.push([ids, paid])
        return writes.length === 1 ? ['one', 'two'] : []
      },
      async undoPayment(ids, paid) { undos.push([ids, paid]); return ids },
    },
    calculateMonth: summarize,
  })

  const ids = ['one', 'two', 'unchanged'], scope = { platformId: 'shop' }
  const pay = () => session.markPayments(ids, true, scope, changed => saved.push(changed))
  await pay()
  assert.equal(session.needsReload.value, true)
  assert.equal(session.lastPayment.value, null)
  assert.deepEqual(saved, [])
  await pay()
  canRead = true
  await session.retryRead()
  await session.retryRead()
  assert.deepEqual(writes, [[ids, true]])
  assert.deepEqual(saved, [['one', 'two']])
  assert.equal(session.notice.value, t('ledger.markedPaid', { count: 2, amount: formatMoney(21111) }))
  assert.deepEqual(session.lastPayment.value, { ...scope, ids: ['one', 'two'], paid: true })

  await session.markPayments(['unchanged'], true, scope, changed => saved.push(changed))
  assert.deepEqual(saved.at(-1), [])
  assert.equal(session.notice.value, t('ledger.updated'))
  session.invalidatePaymentUndo(['one', 'unrelated'])
  assert.deepEqual(session.lastPayment.value, { ...scope, ids: ['two'], paid: true })
  await session.undoPayment()
  assert.deepEqual(undos, [[['two'], false]])
  assert.equal(session.lastPayment.value, null)
})

test('月账单恢复待还支持原还款接口撤销，写入失败保留上一笔操作', async () => {
  const entry = { id: 'a', platformId: 'shop', kind: 'single', status: 'due', month: '2026-12', amountCents: 4200 }
  const snapshot = { entries: [entry], platforms: [], settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {} }
  const calls = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {
    async load() { return snapshot },
    async setPayment(ids, paid) {
      calls.push([ids, paid])
      if (ids.includes('fail')) throw Error('保存失败')
      return ids
    },
  } })
  await session.markPayments(['a'], false, { month: entry.month })
  assert.equal(session.notice.value, t('ledger.markedDue', { count: 1, amount: formatMoney(entry.amountCents) }))
  let saved = false
  await session.markPayments(['fail'], true, { platformId: 'shop' }, () => { saved = true })
  assert.equal(saved, false)
  assert.equal(session.error.value, '保存失败')
  assert.deepEqual(session.lastPayment.value, { month: entry.month, ids: ['a'], paid: false })
  await session.undoPayment()
  assert.deepEqual(calls, [[['a'], false], [['fail'], true], [['a'], true]])
  assert.equal(session.lastPayment.value, null)
})

test('服务端已还款但响应丢失时重试原请求，可恢复实际金额、笔数和撤销', async () => {
  const scope = { platformId: 'shop' }
  const entries = [
    { id: 'b', amountCents: 4200, month: '2026-12' },
    { id: 'a', amountCents: 310, month: '2027-01' },
  ].map(entry => ({ ...entry, platformId: 'shop', kind: 'single', status: 'due' }))
  const snapshot = { entries, platforms: [], settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, salaryOverrides: {} }
  const receipts = new Map(), calls = [], saved = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {
    async load() { return snapshot },
    async setPayment(ids, paid, operationId) {
      calls.push({ ids, paid, operationId })
      const receipt = receipts.get(operationId)
      if (receipt) {
        assert.deepEqual(ids, receipt.ids)
        return receipt.changed
      }
      const changed = entries.filter(entry => ids.includes(entry.id) && entry.status === 'due')
      for (const entry of changed) entry.status = 'paid'
      receipts.set(operationId, { ids, changed: changed.map(entry => entry.id) })
      if (calls.length === 1) throw Error('响应丢失')
      return receipts.get(operationId).changed
    },
    async undoPayment(ids, paid) {
      assert.equal(paid, false)
      for (const entry of entries.filter(entry => ids.includes(entry.id))) entry.status = 'due'
      return ids
    },
  } })
  const onSaved = ids => saved.push(ids)

  await session.markPayments(['b', 'a'], true, scope, onSaved)
  assert.equal(session.error.value, '响应丢失')
  assert.deepEqual(saved, [])
  assert.equal(session.lastPayment.value, null)
  await session.markPayments(['a', 'b'], true, scope, onSaved)
  assert.ok(calls[0].operationId)
  assert.deepEqual(calls[1], calls[0])
  assert.equal(session.notice.value, t('ledger.markedPaid', { count: 2, amount: formatMoney(4510) }))
  assert.deepEqual(session.lastPayment.value, { ...scope, ids: ['b', 'a'], paid: true })
  assert.deepEqual(saved, [['b', 'a']])

  await session.undoPayment()
  await session.markPayments(['b', 'a'], true, scope, onSaved)
  assert.notEqual(calls[2].operationId, calls[0].operationId)
  assert.deepEqual(saved, [['b', 'a'], ['b', 'a']])
})

test('失败后变更还款范围、目标状态或账单集合时使用新的请求标识', async () => {
  const keys = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {
    async setPayment(_ids, _paid, operationId) { keys.push(operationId); throw Error('网络中断') },
  } })
  await session.markPayments(['a'], true, { month: '2026-12' })
  await session.markPayments(['a'], true, { platformId: 'shop' })
  await session.markPayments(['a'], false, { platformId: 'shop' })
  await session.markPayments(['a', 'b'], false, { platformId: 'shop' })
  assert.equal(new Set(keys).size, 4)
})
