import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { createSyncSession } from '../src/app/syncSession.ts'

const linked = { bound: true, authenticated: true, ledgerId: 'shared', url: 'https://wallet.test', pending: 0, cursor: 1, undoableIds: [], conflicts: [] }
const snapshot = { platforms: [], entries: [], salaryOverrides: {}, settings: { defaultSalaryCents: 0, warningFloorCents: 0 } }

test('绑定发送已预览的账本和游标，数据刷新失败只重读本机', async () => {
  const calls = []
  let reads = 0
  const ledger = createLedgerSession({ repository: { load: async () => {
    if (++reads === 1) throw Error('Read failed')
    return snapshot
  } } })
  const sync = createSyncSession(async (command, args) => { calls.push([command, args]); return linked }, ledger, () => true)
  await sync.bind('https://wallet.test', 'session-only', { ledgerId: 'shared', cursor: 47 })
  assert.equal(ledger.needsReload.value, true)
  assert.equal(sync.status.value.bound, true)
  await ledger.retryRead()
  assert.deepEqual(calls, [['sync_bind', { url: 'https://wallet.test', token: 'session-only', ledgerId: 'shared', cursor: 47 }]])
  assert.equal(reads, 2)
})

test('两个触发同时请求同步时仅上传一次，表单编辑期间延迟刷新', async () => {
  let finish, safe = false, calls = 0, reads = 0
  const ledger = createLedgerSession({ repository: { load: async () => { reads++; return snapshot } } })
  const sync = createSyncSession(() => { calls++; return new Promise(resolve => { finish = resolve }) }, ledger, () => safe)
  const request = sync.run()
  assert.equal(await sync.run(), undefined)
  safe = true
  await sync.refreshLedger()
  assert.equal(reads, 0, 'wait until the native command has applied the pull')
  safe = false
  finish(linked)
  await request
  assert.equal(calls, 1)
  assert.equal(reads, 0)
  safe = true
  await sync.refreshLedger()
  await sync.refreshLedger()
  assert.equal(reads, 1)
})

test('服务端拒绝令牌时更新认证状态，冲突保留在本地等待手动选择', async () => {
  const ledger = createLedgerSession({ repository: { load: async () => snapshot } })
  const conflict = { operationId: 'old', changes: [], records: [] }
  const commands = []
  const sync = createSyncSession(async (command, args) => {
    commands.push([command, args])
    if (command === 'sync_run') throw Error('SYNC_AUTH')
    if (command === 'sync_status') return { ...linked, authenticated: false, conflicts: [conflict] }
    return linked
  }, ledger, () => true)
  assert.equal(await sync.run(), undefined)
  assert.equal(sync.status.value.authenticated, false)
  assert.deepEqual(sync.status.value.conflicts, [conflict])
  assert.match(sync.error.value, /令牌|token/i)
  await sync.resolve('old', 'local')
  assert.deepEqual(commands.at(-1), ['sync_resolve', { operationId: 'old', choice: 'local' }])
})

test('同步只保留仍属于本机的撤销权，已确认自己的更改仍可撤销', async () => {
  const ledger = createLedgerSession({ repository: { load: async () => snapshot } })
  let result = { ...linked, undoableIds: ['first', 'second'] }
  const sync = createSyncSession(async () => result, ledger, () => true)
  ledger.lastPayment.value = { month: '2026-12', paid: true, ids: ['first', 'second'] }
  await sync.run()
  assert.deepEqual(ledger.lastPayment.value.ids, ['first', 'second'])
  result = { ...linked, cursor: 9, undoableIds: ['second'] }
  await sync.run()
  assert.deepEqual(ledger.lastPayment.value.ids, ['second'])
  result = { ...linked, cursor: 10, undoableIds: [] }
  await sync.run()
  assert.equal(ledger.lastPayment.value, null)
})
