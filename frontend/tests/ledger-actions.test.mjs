import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { createLedgerActionScope } from '../src/features/ai/ledgerActions.ts'

const month = '2026-11'
function bill(id, fields = {}) {
  return { id, platformId: 'p', title: '同名账单', month, amountCents: 1000,
    kind: 'single', status: 'due', installmentCount: null, installmentIndex: null, ...fields }
}

async function app(entries) {
  const ledger = { entries, platforms: [{ id: 'p', name: '测试平台' }], salaryOverrides: {},
    settings: { defaultSalaryCents: 0, warningFloorCents: 0 } }
  const writes = []
  let failRefresh = false
  const repo = {
    load: async () => {
      if (failRefresh) throw new Error('read failed')
      return structuredClone(ledger)
    },
    beginReviewedWrite: async () => ({ ledger: structuredClone(ledger), repository: guarded }),
  }
  const guarded = {
    setPayment: async (ids, paid, op) => {
      writes.push({ ids, paid, op })
      ids.forEach(id => { ledger.entries.find(entry => entry.id === id).status = paid ? 'paid' : 'due' })
      return ids
    },
    undoPayment: async (ids, paid) => { writes.push({ undo: ids, paid }); return ids },
    confirmEstimate: async input => {
      writes.push(input)
      Object.assign(ledger.entries.find(entry => entry.id === input.id), input, { status: input.amountCents ? 'due' : 'paid' })
    },
    voidEntries: async (ids, op) => { writes.push({ ids, op }); return ids },
    setInstallmentVoided: async (id, voided, op) => { writes.push({ id, voided, op }); return entries.map(entry => entry.id) },
    setEntryVoided: async (id, voided, op) => { writes.push({ id, voided, op }) },
  }
  const session = createLedgerSession({ repository: repo, calculateMonth: summarize })
  session.calendarMonth.value = month
  session.selectMonth(month)
  await session.retryRead()
  const scope = (ids = entries.map(entry => entry.id)) => createLedgerActionScope(session, month, ids)
  return { ledger, session, writes, guarded, scope, failRefresh: flag => { failRefresh = flag } }
}

test('payment and conditional undo use only the frozen row mapping and accepted IDs', async () => {
  const { session, scope, writes } = await app([bill('a'), bill('b'), bill('c')])
  const selection = ['c', 'b']
  const run = scope(selection)
  selection.reverse()
  assert.throws(() => run.prepare('mark_bills_paid', { rows: [3] }))
  assert.throws(() => run.prepare('mark_bills_paid', { rows: [1, 1] }))
  assert.throws(() => run.prepare('unknown_action', { rows: [1] }))
  const action = run.prepare('mark_bills_paid', { rows: [1] })
  assert.equal(writes.length, 0)
  assert.equal(await action.apply(), 'applied')
  assert.equal(await action.apply(), 'applied')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ids, ['c'])
  assert.deepEqual(session.lastPayment.value.ids, ['c'])
  assert.throws(() => scope(['b', 'c']).prepare('undo_last_payment', { rows: [1] }))
  await scope(['b', 'c']).prepare('undo_last_payment', { rows: [2] }).apply()
  assert.deepEqual(writes[1], { undo: ['c'], paid: false })
  assert.equal(session.lastPayment.value, null)
})

test('a changed, moved or unselected row cannot be written after the preview', async () => {
  const { ledger, writes, scope } = await app([bill('a'), bill('b')])
  const run = scope(['a'])
  const action = run.prepare('void_bills', { rows: [1] })
  ledger.entries[0].amountCents++
  await assert.rejects(action.apply(), /已变化/)
  ledger.entries[0].month = '2026-12'
  await assert.rejects(action.apply(), /已变化/)
  assert.equal(writes.length, 0)
})

test('an undo that no longer owns the entire batch reports only the actual changes', async () => {
  const { scope, guarded, session } = await app([bill('a', { status: 'paid' }), bill('b', { status: 'paid' })])
  session.lastPayment.value = { ids: ['a', 'b'], month, paid: true }
  guarded.undoPayment = async () => ['b']
  const action = scope().prepare('undo_last_payment', { rows: [1, 2] })
  assert.equal(await action.apply(), 'partial')
  assert.equal(action.changedCount, 1)
  assert.equal(session.lastPayment.value, null)
})

test('confirming a carried estimate preserves its deposit and accepts an explicitly revised title, month and remaining balance', async () => {
  const { scope, writes } = await app([bill('a', { status: 'estimated', kind: 'estimate', month: '2026-10',
    amountCents: 8000, depositCents: 2000 })])
  const run = scope()
  assert.throws(() => run.prepare('confirm_estimate', { row: 1, amountCents: -1 }))
  const args = { row: 1, amountCents: 0, month: '2026-12', title: '预订画册' }
  const action = run.prepare('confirm_estimate', args)
  assert.match(action.lines.join(' '), /预订画册/)
  args.amountCents = 2500
  await action.apply()
  assert.deepEqual(writes, [{ id: 'a', amountCents: 0, depositCents: 2000, totalCents: 2000,
    title: '预订画册', month: '2026-12' }])
})

test('whole-plan previews include every period and detect changes outside the selected month', async () => {
  const period = { kind: 'installment', installmentId: 'plan', installmentCount: 2 }
  const { scope, writes, ledger } = await app([bill('1', { ...period, installmentIndex: 1 }),
    bill('2', { ...period, month: '2026-12', installmentIndex: 2 })])
  const run = scope(['1'])
  const whole = run.prepare('void_bills', { rows: [1], scope: 'installment' })
  assert.match(whole.lines.join(' '), /整笔分期/)
  assert.match(whole.lines.join(' '), /12 月/)
  ledger.entries[1].status = 'paid'
  await assert.rejects(whole.apply(), /已变化/)
  assert.equal(writes.length, 0)
  await run.prepare('void_bills', { rows: [1] }).apply()
  assert.deepEqual(writes[0].ids, ['1'])
  ledger.entries[1].status = 'due'
  await whole.apply()
  assert.deepEqual([writes[1].id, writes[1].voided], ['1', true])
})

test('confirmation can revise total and deposit consistently and expose old and new amounts in its preview', async () => {
  const { scope, writes } = await app([bill('a', { kind: 'estimate', status: 'estimated', amountCents: 8000, depositCents: 2000 })])
  const run = scope()
  assert.throws(() => run.prepare('confirm_estimate', { row: 1, amountCents: 5000, totalCents: 9000, depositCents: 2000 }))
  assert.throws(() => run.prepare('confirm_estimate', { row: 1, depositCents: 10001 }))
  const action = run.prepare('confirm_estimate', { row: 1, depositCents: 4500 })
  assert.match(action.lines.join(' '), /20.*→.*45/)
  await action.apply()
  assert.equal(writes[0].amountCents, 5500)
  assert.equal(writes[0].totalCents, 10000)
  assert.equal(writes[0].depositCents, 4500)
})

test('later proposals can depend on earlier confirmed edits while already displayed previews remain frozen', async () => {
  const { scope, writes } = await app([bill('first', { status: 'estimated', kind: 'estimate' }), bill('other')])
  const run = scope(['other', 'first'])
  const old = run.prepare('void_bills', { rows: [2] })
  await run.prepare('confirm_estimate', { row: 2, amountCents: 2500 }).apply()
  await assert.rejects(old.apply(), /已变化/)
  await run.prepare('mark_bills_paid', { rows: [2] }).apply()
  await run.prepare('undo_last_payment', { rows: [2] }).apply()
  assert.equal(writes.length, 3)
  assert.equal(writes[0].id, 'first')
  assert.deepEqual(writes[1].ids, ['first'])
  assert.deepEqual(writes[2].undo, ['first'])
})

test('a newly approved platform can be used in the same request when no ledger data was shared', async () => {
  const { scope, ledger, guarded, writes } = await app([])
  guarded.createPlatform = async name => { ledger.platforms.push({ id: 'new', name }); return 'new' }
  guarded.createBills = async inputs => { writes.push(...inputs) }
  const run = scope([])
  const args = { platform: '新平台', title: '新账单', kind: 'single', amountCents: 3300 }
  assert.throws(() => run.prepare('create_bill', args))
  await run.prepare('create_platform', { name: '新平台' }).apply()
  await run.prepare('create_bill', args).apply()
  assert.equal(writes[0].platformId, 'new')
  assert.equal(writes[0].month, month)
})

test('write-success/read-failure retries only the ledger read', async () => {
  const { scope, writes, session, failRefresh } = await app([bill('a', { voided: true })])
  const action = scope().prepare('restore_bill', { row: 1 })
  failRefresh(true)
  assert.equal(await action.apply(), 'refreshPending')
  assert.equal(await action.apply(), 'refreshPending')
  assert.equal(writes.length, 1)
  assert.equal(session.needsReload.value, true)
  failRefresh(false)
  await session.retryRead()
  assert.equal(await action.apply(), 'applied')
  assert.equal(writes.length, 1)
})
