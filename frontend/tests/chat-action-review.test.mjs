import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { useLedgerActionReview } from '../src/features/ai/useLedgerActionReview.ts'
import { setLocale } from '../src/i18n/index.ts'
import { parseLocalReminderTime } from '../src/features/reminders/reminderActions.ts'
import { formatReminderRecurrence } from '../src/features/reminders/recurrenceFormat.ts'

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

test('reminder approvals preserve the requested local instant and optional subject, and write once', async t => {
  const start = new Date(2030, 5, 10, 20, 5)
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const writes = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {} })
  const window = useLedgerActionReview(session, async input => { writes.push(input); return { status: 'scheduled' } })
  const run = window.forTurn('2026-11', [])
  const active = new AbortController().signal
  const aborted = new AbortController()
  const cancelled = run('send_pet_notification', {}, aborted.signal)
  assert.equal(window.review.value.name, 'send_pet_notification')
  aborted.abort()
  assert.equal((await cancelled).status, 'cancelled')
  assert.deepEqual(writes, [])
  t.mock.timers.tick(1000)
  const approved = run('schedule_pet_popup', { delaySeconds: 600 }, active)
  assert.equal(window.review.value.lines.length, 2)
  assert.match(window.review.value.lines[1], /桌宠/)
  assert.deepEqual(writes, [])
  window.confirm()
  window.confirm()
  assert.equal((await approved).status, 'applied')
  assert.deepEqual(writes, [{ channel: 'popup', text: '', at: start.getTime() + 600000 }])
  const notification = run('schedule_pet_notification', { text: ' 带钥匙 ', atLocal: '2030-06-11T09:05' }, active)
  assert.equal(window.review.value.lines[1], '带钥匙')
  window.confirm()
  assert.equal((await notification).status, 'applied')
  assert.deepEqual(writes[1], { channel: 'notification', text: '带钥匙', at: new Date(2030, 5, 11, 9, 5).getTime() })
  const expired = run('schedule_pet_popup', { delaySeconds: 5 }, active)
  t.mock.timers.tick(5000)
  window.confirm()
  assert.equal((await expired).status, 'failed')
  assert.equal(writes.length, 2)
  for (const args of [{ delaySeconds: 0 }, { delaySeconds: 1e30 }, { atLocal: '2030-02-30T12:00' }, { atLocal: '2005-06-11T09:05' }]) {
    assert.equal((await run('schedule_pet_popup', args, active)).status, 'failed')
    assert.equal(window.review.value, null)
  }
  for (const invalid of ['2030-13-01T10:00', '2030-12-01T24:00', '2030-12-01T23:00Z', '2030-12-01']) {
    assert.throws(() => parseLocalReminderTime(invalid), /REMINDER_INVALID_TIME/)
  }
})

test('an immediate reminder reports delivery failure after confirmation', async () => {
  const session = createLedgerSession({ calculateMonth: summarize, repository: {} })
  const window = useLedgerActionReview(session, async () => { throw new Error('REMINDER_STORAGE') })
  const result = window.forTurn('2026-11', [])('show_pet_popup', { text: '休息' }, new AbortController().signal)
  window.confirm()
  assert.equal((await result).status, 'failed')
})

test('monthly notification previews the repeating rule and next local time, and approves only that series', async t => {
  // The 10th at 09:00 has already passed, so the first payment reminder is next month.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2030, 5, 10, 9, 1) })
  const next = new Date(2030, 6, 10, 9)
  const writes = []
  const session = createLedgerSession({ calculateMonth: summarize, repository: {} })
  const review = useLedgerActionReview(session, async input => { writes.push(input); return { status: 'scheduled' } })
  const run = review.forTurn('2026-11', [])
  const active = new AbortController().signal
  const rule = { frequency: 'monthly', time: '09:00', dayOfMonth: 10 }
  const args = { text: '还款', recurrence: rule }
  const cancelled = run('schedule_pet_notification', args, active)
  assert.equal(review.review.value.lines[0], '每月 10 日 09:00')
  assert.match(review.review.value.lines[1], /下次提醒.*2030/)
  assert.equal(review.review.value.lines[2], '还款')
  review.decline()
  assert.equal((await cancelled).status, 'cancelled')
  assert.deepEqual(writes, [])
  const approved = run('schedule_pet_notification', args, active)
  review.confirm()
  review.confirm()
  assert.match((await approved).message, /系统通知.*每月 10 日 09:00.*下次提醒/)
  assert.deepEqual(writes, [{ channel: 'notification', text: '还款', at: next.getTime(), recurrence: rule }])
  const expired = run('schedule_pet_notification', args, active)
  t.mock.timers.setTime(next.getTime())
  review.confirm()
  assert.equal((await expired).status, 'failed')
  assert.equal(writes.length, 1)
})

test('recurring rule summaries use the current language and ISO weekday', () => {
  for (const [language, days] of [
    ['zh-CN', ['每天 09:00', '每周一 09:00', '每周日 09:00', '每月 31 日 09:00']],
    ['en-US', ['Every day at 09:00', 'Every Monday at 09:00', 'Every Sunday at 09:00', 'Day 31 of every month at 09:00']],
  ]) {
    try {
      setLocale(language)
      assert.deepEqual([
        { frequency: 'daily', time: '09:00' }, { frequency: 'weekly', time: '09:00', weekday: 1 },
        { frequency: 'weekly', time: '09:00', weekday: 7 }, { frequency: 'monthly', time: '09:00', dayOfMonth: 31 },
      ].map(formatReminderRecurrence), days)
    } finally {
      setLocale('zh-CN')
    }
  }
})
