import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks'
import { chatWithAgent } from '../src/integrations/ai/agentChat.ts'
import { createLedgerSession } from '../src/app/ledgerSession.ts'
import { summarize } from '../src/domain/ledger.ts'
import { useLedgerActionReview } from '../src/features/ai/useLedgerActionReview.ts'
import { nextReminderOccurrence } from '../src/features/reminders/recurrence.ts'
import { createReminderService } from '../src/features/reminders/reminderService.ts'

globalThis.window = {}
afterEach(clearMocks)

const message = { role: 'user', content: '我勾选的账单还有多少没还？' }
const general = { mode: 'general', language: 'zh-CN', messages: [message] }
const toolCall = { id: 'call-1', name: 'inspect_selected_bills', arguments: {} }
const run = input => chatWithAgent(input, new AbortController().signal)

async function inspect(entries) {
  let result
  const input = {
    ...general,
    facts: { month: '2026-11', balanceCents: 333, dueCents: 99999, warningFloorCents: 0 },
    details: { month: '2026-11', entries },
  }
  const requests = []
  mockIPC((command, payload) => {
    assert.equal(command, 'ai_agent_chat_turn')
    requests.push(payload.requestId)
    assert.equal(payload.mode, 'general')
    assert.deepEqual(payload.messages, [message])
    if (!payload.toolRounds.length) return { text: '', calls: [toolCall] }
    assert.equal(payload.toolRounds.length, 1)
    const round = payload.toolRounds[0]
    assert.deepEqual(round.calls, [toolCall])
    assert.equal(round.results[0].id, toolCall.id)
    result = JSON.parse(round.results[0].content)
    return { text: '已核对。', calls: [] }
  })
  assert.equal(await run(input), '已核对。')
  assert.equal(new Set(requests).size, 2)
  return result
}

function bill(title, amountCents, status = 'due') {
  return { platform: '测试平台', title, kind: 'single', status, amountCents }
}

test('Pi executes only the checked-bills tool and returns exact totals and all ties to the next model turn', async () => {
  const entries = [
    { ...bill('A', 999), id: 'local-id' }, bill('B', 999), bill('C', 1),
    bill('Paid', 5000, 'paid'),
    { ...bill('Estimate', 4500, 'estimated'), kind: 'estimate', depositCents: 100 },
  ]
  const summary = await inspect(entries)
  assert.equal(summary.month, '2026-11')
  assert.equal(summary.dueCents, 1999)
  assert.equal(summary.dueCount, 3)
  assert.equal(summary.estimatedCents, 4500)
  assert.equal(summary.estimatedCount, 1)
  assert.deepEqual(summary.largestDue.bills.map(row => row.title), ['A', 'B'])
  assert.equal(summary.largestDue.amountCents, 999)
  assert.equal(summary.largestSelected.bills[0].title, 'Paid')
  assert.deepEqual(summary.entries.map(row => row.title), entries.map(row => row.title))
  assert.deepEqual(summary.entries.map(row => row.row), [1, 2, 3, 4, 5])
  assert.ok(!JSON.stringify(summary).includes('local-id'))
})

test('selected voided bills retain their row numbers for restoration and are excluded from totals and maxima', async () => {
  const summary = await inspect([{ ...bill('之前作废的账单', 12000), voided: true }, bill('待还', 1500)])
  assert.equal(summary.entries[0].voided, true)
  assert.equal(summary.entries[1].row, 2)
  assert.equal(summary.dueCents, 1500)
  assert.equal(summary.largestSelected.amountCents, 1500)
})

test('a paid-only selection has zero outstanding and no largest unpaid bill', async () => {
  const summary = await inspect([bill('Paid', 300, 'paid')])
  assert.equal(summary.dueCents, 0)
  assert.equal(summary.largestDue, null)
})

test('pet mode carries its persona and chat without shared bills cannot execute a tool', async () => {
  const character = { name: 'Fox', description: '侦探', voiceSample: '搭档' }
  mockIPC((_command, payload) => {
    assert.equal(payload.mode, 'pet')
    assert.deepEqual(payload.character, character)
    assert.equal(payload.details, undefined)
    return { text: '你好！', calls: [] }
  })
  assert.equal(await run({ ...general, mode: 'pet', character }), '你好！')
  mockIPC(() => ({ text: '', calls: [toolCall] }))
  await assert.rejects(run(general), /AI_BAD_RESPONSE/)
})

test('cancel interrupts the active native turn and native errors keep their public code', async () => {
  const control = new AbortController()
  const started = Promise.withResolvers()
  const completion = Promise.withResolvers()
  const calls = []
  mockIPC((command, payload) => {
    calls.push([command, payload.requestId])
    if (command === 'ai_cancel') return completion.resolve({ text: 'late', calls: [] })
    started.resolve()
    return completion.promise
  })
  const pending = chatWithAgent(general, control.signal)
  await started.promise
  control.abort()
  await assert.rejects(pending, /AI_CANCELLED/)
  assert.deepEqual(calls.map(([command]) => command), ['ai_agent_chat_turn', 'ai_cancel'])
  assert.equal(calls[0][1], calls[1][1])
  mockIPC(() => Promise.reject('AI_AUTH'))
  await assert.rejects(run(general), /AI_AUTH/)
})

test('mixed read/write batches confirm each distinct action separately and return local receipts without another provider turn', async () => {
  const calls = [
    toolCall,
    { id: 'pay1', name: 'mark_bills_paid', arguments: { rows: [2, 1] } },
    { id: 'pay2', name: 'mark_bills_paid', arguments: { rows: [1, 2] } },
    { id: 'platform', name: 'create_platform', arguments: { name: '合成平台' } },
  ]
  const accepted = []
  let nativeTurns = 0
  mockIPC((_command, payload) => {
    nativeTurns++
    assert.equal(payload.actionToolsEnabled, true)
    assert.ok(!Object.hasOwn(payload, 'runAction'))
    return { text: '', calls }
  })
  const input = {
    ...general, facts: { month: '2026-11', balanceCents: 0, dueCents: 99999, warningFloorCents: 0 },
    details: { month: '2026-11', entries: [bill('A', 900), bill('B', 1100)] },
  }
  const answer = await chatWithAgent(input, new AbortController().signal, async (name, args, signal) => {
    assert.equal(signal.aborted, false)
    accepted.push([name, args])
    return name === 'mark_bills_paid' ? { status: 'applied', message: '确认还款。' } : { status: 'cancelled', message: '已取消新增平台。' }
  })
  assert.equal(nativeTurns, 1)
  assert.deepEqual(accepted, [['mark_bills_paid', { rows: [2, 1] }], ['create_platform', { name: '合成平台' }]])
  assert.equal(answer, '确认还款。\n已取消新增平台。')
})

test('new bills can be requested from chat without sharing rows; mutations on existing bills need a checked selection', async () => {
  const input = { ...general, messages: [{ role: 'user', content: '帮我记一笔' }] }
  const args = { kind: 'single', platform: 'A', title: 'B', amountCents: 50, month: '2026-11' }
  const call = { id: 'create', name: 'create_bill', arguments: args }
  mockIPC(() => ({ text: '', calls: [call] }))
  let count = 0
  const confirm = async (name, received) => {
    count++
    assert.equal(name, 'create_bill')
    assert.deepEqual(received, args)
    return { status: 'saved_pending_refresh', message: '已保存，等待读回。' }
  }
  assert.equal(await chatWithAgent(input, new AbortController().signal, confirm), '已保存，等待读回。')
  await assert.rejects(run(input), /AI_BAD_RESPONSE/)
  mockIPC(() => ({ text: '', calls: [{ id: 'pay', name: 'mark_bills_paid', arguments: { rows: [1] } }] }))
  await assert.rejects(chatWithAgent(input, new AbortController().signal, confirm), /AI_BAD_RESPONSE/)
  assert.equal(count, 1)
})

test('a malformed sibling call never partially applies its batch; an intentional null salary override reaches review', async () => {
  const input = { ...general, messages: [{ role: 'user', content: '撤掉这个月的工资覆盖' }] }
  const clearOverride = { id: 'budget', name: 'update_budget', arguments: { overrideSalaryCents: null } }
  const invalid = { id: 'platform', name: 'create_platform', arguments: {} }
  let reviewed = 0
  const runAction = async (name, args) => {
    reviewed++
    assert.equal(name, 'update_budget')
    assert.deepEqual(args, { overrideSalaryCents: null })
    return { status: 'applied', message: '已更新预算。' }
  }
  mockIPC(() => ({ text: '', calls: [clearOverride, invalid] }))
  await assert.rejects(chatWithAgent(input, new AbortController().signal, runAction), /AI_BAD_RESPONSE/)
  assert.equal(reviewed, 0)
  mockIPC(() => ({ text: '', calls: [clearOverride] }))
  assert.equal(await chatWithAgent(input, new AbortController().signal, runAction), '已更新预算。')
  assert.equal(reviewed, 1)
})

test('both chat modes expose all pet reminders without ledger sharing and finish with local receipts', async () => {
  const cases = [
    ['show_pet_popup', {}],
    ['send_pet_notification', { text: '带钥匙' }],
    ['schedule_pet_popup', { delaySeconds: 600 }],
    ['schedule_pet_notification', { atLocal: '2030-06-11T09:05' }],
    ['schedule_pet_popup', { recurrence: { frequency: 'daily', time: '08:00' } }],
    ['schedule_pet_popup', { recurrence: { frequency: 'weekly', time: '18:30', weekday: 7 } }],
    ['schedule_pet_notification', { text: '还款', recurrence: { frequency: 'monthly', time: '09:00', dayOfMonth: 10 } }],
    ['schedule_pet_popup', { text: '喝水', recurrence: { frequency: 'interval', minutes: 44640 } }],
    ['schedule_pet_notification', { text: '吃饭', recurrence: { frequency: 'randomWindow', startTime: '11:30', endTime: '13:00' } }],
  ]
  for (const input of [general, { ...general, mode: 'pet', character: { name: 'Fox', description: '', voiceSample: '' } }]) {
    let requests = 0
    mockIPC((_command, payload) => {
      requests++
      assert.equal(payload.details, undefined)
      assert.equal(payload.facts, undefined)
      const duplicate = ['schedule_pet_popup', { delaySeconds: 600, text: '  ' }]
      const repeatedSeries = ['schedule_pet_notification', { recurrence: { dayOfMonth: 10, time: '09:00', frequency: 'monthly' }, text: ' 还款 ' }]
      const repeatedWindow = ['schedule_pet_notification', { text: ' 吃饭 ', recurrence: { endTime: '13:00', frequency: 'randomWindow', startTime: '11:30' } }]
      return { text: '', calls: [...cases, duplicate, repeatedSeries, repeatedWindow].map(([name, args], i) => ({ id: 'remind' + i, name, arguments: args })) }
    })
    const reviewed = []
    const answer = await chatWithAgent(input, new AbortController().signal, async (name, args) => {
      reviewed.push([name, args])
      return { status: 'applied', message: 'saved ' + name }
    })
    assert.deepEqual(reviewed, cases)
    assert.equal(answer, cases.map(([name]) => 'saved ' + name).join('\n'))
    assert.equal(requests, 1)
  }
})

test('inconsistent time modes and invalid recurrence rules cannot start a write', async () => {
  const daily = { frequency: 'daily', time: '09:00' }
  for (const args of [
    {}, { atLocal: '2030-06-11T09:05', delaySeconds: 60 }, { delaySeconds: 60, repeat: 'daily' },
    { atLocal: '2030-06-11T09:05', recurrence: daily }, { delaySeconds: 60, recurrence: daily },
    { recurrence: { ...daily, weekday: 4 } }, { recurrence: { ...daily, time: '24:00' } },
    { recurrence: { ...daily, frequency: 'weekly' } }, { recurrence: { ...daily, frequency: 'weekly', weekday: 0 } },
    { recurrence: { ...daily, frequency: 'monthly', dayOfMonth: 32 } },
    { recurrence: { ...daily, frequency: 'monthly', weekday: 3, dayOfMonth: 10 } },
    { recurrence: { ...daily, endDate: '2030-12-01' } },
    { recurrence: { frequency: 'interval', minutes: 15 } },
    { recurrence: { frequency: 'interval', minutes: 44650 } },
    { recurrence: { frequency: 'interval', minutes: 10, anchorAt: 1 } },
    { recurrence: { frequency: 'interval', minutes: 10, time: '09:00' } },
    { recurrence: { frequency: 'randomWindow', startTime: '11:30', endTime: '11:30' } },
    { recurrence: { frequency: 'randomWindow', startTime: '11:30', endTime: '25:00' } },
    { recurrence: { frequency: 'randomWindow', startTime: '11:30', endTime: '13:00', seed: 100 } },
    { delaySeconds: 600, testOnly: true },
  ]) {
    mockIPC(() => ({ text: '', calls: [{ id: 'schedule', name: 'schedule_pet_popup', arguments: args }] }))
    let reviews = 0
    await assert.rejects(chatWithAgent(general, new AbortController().signal, async () => { reviews++ }), /AI_BAD_RESPONSE/, JSON.stringify(args))
    assert.equal(reviews, 0)
  }
})

test('Pi confirms the same interval and random window occurrences that it saves', async t => {
  const start = new Date(2030, 5, 10, 10, 0).getTime()
  t.mock.timers.enable({ apis: ['Date'], now: start })
  const input = { ...general, messages: [{ role: 'user', content: '每20分钟弹窗提醒喝水，每天午饭时通知我吃饭' }] }
  const interval = { frequency: 'interval', minutes: 20 }
  const window = { frequency: 'randomWindow', startTime: '11:30', endTime: '13:00' }
  mockIPC(() => ({ text: '', calls: [
    { id: 'sip', name: 'schedule_pet_popup', arguments: { recurrence: interval, text: '喝水' } },
    { id: 'lunch', name: 'schedule_pet_notification', arguments: { recurrence: window, text: '吃饭' } },
  ] }))
  const saved = [], previews = []
  const ledger = createLedgerSession({ calculateMonth: summarize, repository: {} })
  const review = useLedgerActionReview(ledger, async plan => { saved.push(plan); return { status: 'scheduled' } })
  const run = review.forTurn('2030-06', [])
  const answer = await chatWithAgent(input, new AbortController().signal, async (name, args, signal) => {
    const pending = run(name, args, signal)
    previews.push({ ...review.review.value })
    review.confirm()
    return pending
  })
  assert.deepEqual(saved.map(p => [p.channel, p.text]), [['popup', '喝水'], ['notification', '吃饭']])
  assert.equal(saved[0].recurrence.anchorAt, start + 20 * 60_000)
  assert.equal(saved[0].at, saved[0].recurrence.anchorAt)
  assert.ok(Number.isInteger(saved[1].recurrence.seed))
  assert.equal(saved[1].at, nextReminderOccurrence(saved[1].recurrence, start))
  assert.ok(saved[1].at >= new Date(2030, 5, 10, 11, 30).getTime() && saved[1].at <= new Date(2030, 5, 10, 13).getTime())
  const times = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
  assert.equal(previews[0].name, 'schedule_pet_popup')
  assert.equal(previews[1].name, 'schedule_pet_notification')
  assert.match(previews[0].lines[0], /20/)
  assert.match(previews[1].lines[0], /11:30.*13:00/)
  for (const [i, plan] of saved.entries()) {
    const time = times.format(plan.at)
    assert.ok(previews[i].lines[1].includes(time))
    assert.ok(answer.includes(time))
  }
})

test('an approved Pi reminder test uses the transient channel once and never adds a task', async () => {
  const input = { ...general, messages: [{ role: 'user', content: '测试一下吃饭弹窗，再发一条睡觉的测试通知' }] }
  const notification = { name: 'send_pet_notification', arguments: { text: '睡觉', testOnly: true } }
  mockIPC(() => ({ text: '', calls: [
    { id: 'popup', name: 'show_pet_popup', arguments: { testOnly: true, text: '吃饭' } },
    { id: 'test-notice', ...notification }, { id: 'repeat-notice', ...notification },
  ] }))
  const notices = [], subjects = [], approvals = []
  const reminders = createReminderService({
    now: Date.now, visible: () => true,
    store: { list: async () => [], add: async () => assert.fail('A reminder test must not add a task') },
    async prepareText(text) { subjects.push(text); return { petId: 'cat', petName: 'Cat', message: text } },
    delivery: { async notify(...args) { notices.push(args) } },
  })
  const ledger = createLedgerSession({ calculateMonth: summarize, repository: {} })
  const review = useLedgerActionReview(ledger, reminders.create, reminders.test)
  const active = new AbortController().signal
  const run = review.forTurn('2030-06', [])
  const cancelled = run(notification.name, notification.arguments, active)
  review.decline()
  assert.equal((await cancelled).status, 'cancelled')
  assert.deepEqual(subjects, [])
  const answer = await chatWithAgent(input, active, async (name, args, signal) => {
    const pending = run(name, args, signal)
    approvals.push({ ...review.review.value })
    review.confirm()
    review.confirm()
    return pending
  })
  assert.deepEqual(approvals.map(p => [p.name, p.lines.at(-1)]), [['show_pet_popup', '吃饭'], ['send_pet_notification', '睡觉']])
  assert.ok(approvals.every(p => p.lines[0].includes('测试')))
  assert.deepEqual(subjects, ['吃饭', '睡觉'])
  assert.deepEqual(notices, [[0, 'Cat', '睡觉']])
  assert.equal(reminders.activePopup.value.id, 0)
  assert.equal(reminders.activePopup.value.message, '吃饭')
  assert.deepEqual(reminders.tasks.value, [])
  assert.match(answer, /测试桌宠弹窗.*\n.*测试通知/)
})
