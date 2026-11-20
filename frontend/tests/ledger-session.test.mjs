import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'

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
