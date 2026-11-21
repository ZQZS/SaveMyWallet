import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { useLedgerActionReview } from '../src/features/ai/useLedgerActionReview.ts'

test('preview requires a live approval and double confirmation writes once', async () => {
  const ledger = { settings: { defaultSalaryCents: 0, warningFloorCents: 0 }, platforms: [], entries: [], salaryOverrides: {} }
  let writes = 0
  const session = createLedgerSession({ calculateMonth: summarize, repository: {
    load: async () => structuredClone(ledger),
    createPlatform: async name => { writes++; ledger.platforms.push({ id: 'new', name }) },
  } })
  await session.retryRead()
  const window = useLedgerActionReview(session)
  const run = () => window.forTurn(session.month.value, [])
  const args = { name: '合成平台' }
  const controller = new AbortController()
  const abandoned = run()('create_platform', args, controller.signal)
  assert.match(window.review.value.lines[0], /合成平台/)
  controller.abort()
  window.confirm()
  assert.equal((await abandoned).status, 'cancelled')
  assert.equal(window.review.value, null)
  const active = new AbortController().signal
  const declined = run()('create_platform', args, active)
  window.decline()
  assert.equal((await declined).status, 'cancelled')
  assert.equal(writes, 0)
  const approved = run()('create_platform', args, active)
  window.confirm()
  window.confirm()
  assert.equal((await approved).status, 'applied')
  assert.equal(writes, 1)
})
