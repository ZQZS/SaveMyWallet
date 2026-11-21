import assert from 'node:assert/strict'
import test from 'node:test'
import { createReminderService } from '../src/features/reminders/reminderService.ts'
import { createIntervalRecurrence, createRandomWindowRecurrence, nextReminderOccurrence } from '../src/features/reminders/recurrence.ts'

function setup() {
  const records = new Map()
  const calls = []
  let next = 1
  const state = { time: Date.UTC(2026, 10, 22, 8), visible: true, denied: false, cancelFails: false }
  const store = {
    list: async () => Array.from(records.values(), record => ({ ...record })),
    async add(values) {
      const item = { ...values, id: next++ }
      records.set(item.id, item)
      return { ...item }
    },
    async transition(id, from, to, error, changes, expected) {
      const current = records.get(id)
      if (current?.status !== from || (expected &&
          (current.at !== expected.at || (current.revision ?? 0) !== expected.revision))) return null
      const item = { ...current, ...changes, status: to, error }
      records.set(id, item)
      return { ...item }
    },
    async remove(id, from) {
      return records.get(id)?.status === from && records.delete(id)
    },
  }
  const services = {
    store, now: () => state.time, visible: () => state.visible,
    async prepareText(text, pet, dueAt) {
      calls.push(['wording', text, pet?.id, dueAt])
      return { petId: 'cat', petName: '猫', message: text || '歇一歇吧，喵。' }
    },
    delivery: {
      async schedule(...args) {
        calls.push(['schedule', ...args])
        if (state.denied) throw new Error('REMINDER_PERMISSION')
      },
      async notify(...args) {
        calls.push(['notify', ...args])
        if (state.denied) throw new Error('REMINDER_PERMISSION')
      },
      async cancel(...args) {
        calls.push(['cancel', ...args])
        if (state.cancelFails) throw new Error('REMINDER_DELIVERY')
      },
    },
  }
  return { records, calls, state, store, restart: () => createReminderService(services), service: createReminderService(services) }
}

test('hidden and overdue pet popups survive restart, retain their wording and appear once in due order', async () => {
  const { service, restart, state, calls } = setup()
  state.visible = false
  const second = await service.create({ channel: 'popup', text: '第二条', at: state.time + 1200 })
  const first = await service.create({ channel: 'popup', text: '', at: state.time + 500 })
  state.time += 1300
  await service.refresh()
  assert.equal(service.activePopup.value, null)
  const relaunched = restart()
  state.visible = true
  await relaunched.refresh()
  assert.equal(relaunched.activePopup.value.id, first.id)
  assert.equal(relaunched.activePopup.value.message, '歇一歇吧，喵。')
  await relaunched.refresh()
  assert.equal(relaunched.activePopup.value.id, first.id)
  await relaunched.dismissPopup()
  assert.equal(relaunched.activePopup.value.id, second.id)
  await relaunched.dismissPopup()
  assert.equal(relaunched.activePopup.value, null)
  assert.ok(relaunched.tasks.value.every(task => task.status === 'completed'))
  assert.deepEqual(calls.map(call => call[0]), ['wording', 'wording'])
})

test('immediate popups, cancellations, deletion and invalid time/text stay consistent', async () => {
  const { service, state } = setup()
  await assert.rejects(service.create({ channel: 'popup', text: '', at: state.time }), /REMINDER_INVALID_TIME/)
  await assert.rejects(service.create({ channel: 'popup', text: '😀'.repeat(301) }), /REMINDER_INVALID_TEXT/)
  const now = await service.create({ channel: 'popup', text: '一起伸个懒腰' })
  assert.equal(service.activePopup.value.id, now.id)
  const later = await service.create({ channel: 'popup', text: '等一会', at: state.time + 900 })
  await assert.rejects(service.remove(later.id), /REMINDER_STATE/)
  await service.cancel(later.id)
  state.time += 1000
  await service.dismissPopup()
  assert.equal(service.activePopup.value, null)
  await service.remove(later.id)
  assert.deepEqual(service.tasks.value.map(item => item.id), [now.id])
})

test('an armed system notification is never sent again by the frontend after expiry', async () => {
  const { service, restart, calls, state } = setup()
  const at = state.time + 5000
  const future = await service.create({ channel: 'notification', text: '喝水', at })
  assert.deepEqual(calls[1], ['schedule', future.id, at, '猫', '喝水', true])
  const immediate = await service.create({ channel: 'notification', text: '起身' })
  assert.equal(immediate.status, 'completed')
  state.time = at + 1
  const reopened = restart()
  await reopened.refresh()
  assert.equal(reopened.tasks.value.find(item => item.id === future.id).status, 'completed')
  assert.deepEqual(calls.map(call => call[0]), ['wording', 'schedule', 'wording', 'notify'])
})

test('testing either delivery channel leaves task history and registered schedules untouched', async () => {
  const { service, state, records, calls, restart } = setup()
  const regular = await service.create({ channel: 'notification', text: '还款', at: state.time + 60_000 })
  const before = structuredClone(records.get(regular.id))
  calls.length = 0
  await service.test({ channel: 'notification', text: '吃饭', pet: { id: 'fox' } })
  assert.deepEqual(calls, [['wording', '吃饭', 'fox', undefined], ['notify', 0, '猫', '吃饭']])
  await service.test({ channel: 'popup', text: '睡觉' })
  assert.equal(service.activePopup.value.message, '睡觉')
  assert.equal(restart().activePopup.value, null)
  await service.dismissPopup()
  assert.deepEqual([...records.values()], [before])
  assert.equal(service.tasks.value.length, 1)
  await assert.rejects(service.test({ channel: 'popup', text: 'x'.repeat(301) }), /REMINDER_INVALID_TEXT/)
  state.denied = true
  await assert.rejects(service.test({ channel: 'notification', text: '测试' }), /REMINDER_PERMISSION/)
  assert.deepEqual([...records.values()], [before])
})

test('testing a popup preserves a regular reminder that has already been shown', async () => {
  const { service } = setup()
  const regular = await service.create({ channel: 'popup', text: '还款' })
  await service.test({ channel: 'popup', text: '测试' })
  assert.equal(service.activePopup.value.id, regular.id)
  await service.dismissPopup()
  assert.equal(service.activePopup.value.message, '测试')
  await service.dismissPopup()
  assert.equal(service.activePopup.value, null)
  assert.deepEqual(service.tasks.value.map(t => t.id), [regular.id])
})

test('failed registration is visible, and cancellation can be retried against the original OS ID', async () => {
  const { service, state, calls } = setup()
  const input = { channel: 'notification', text: '喝水', at: state.time + 5000 }
  state.denied = true
  await assert.rejects(service.create(input), /REMINDER_PERMISSION/)
  assert.equal(service.tasks.value[0].error, 'REMINDER_PERMISSION')
  assert.equal(service.tasks.value[0].status, 'failed')
  state.denied = false
  const future = await service.create(input)
  state.cancelFails = true
  await assert.rejects(service.cancel(future.id), /REMINDER_DELIVERY/)
  assert.equal(service.tasks.value[0].status, 'scheduled')
  state.cancelFails = false
  await service.cancel(future.id)
  assert.equal(service.tasks.value[0].status, 'cancelled')
  assert.deepEqual(calls.filter(call => call[0] === 'cancel'), [['cancel', future.id], ['cancel', future.id]])
})

test('interrupted future registrations recover without prompting and immediate notifications never replay', async () => {
  const { service, restart, records, state, calls } = setup()
  const future = await service.create({ channel: 'notification', text: '喝水', at: state.time + 5000 })
  const immediate = await service.create({ channel: 'notification', text: '起身' })
  records.get(future.id).status = 'preparing'
  records.get(immediate.id).status = 'preparing'
  calls.length = 0
  await restart().refresh()
  assert.deepEqual(calls, [['schedule', future.id, future.at, '猫', '喝水', false]])
  assert.equal(records.get(immediate.id).error, 'REMINDER_INTERRUPTED')
  assert.equal(records.get(future.id).status, 'scheduled')
})

test('an accepted native notification with a failed local receipt is reconciled without sending again', async () => {
  const { service, calls, store, records } = setup()
  const transition = store.transition
  let first = true
  store.transition = async (...args) => {
    if (first) {
      first = false
      throw new Error('REMINDER_STORAGE')
    }
    return transition(...args)
  }
  const task = await service.create({ channel: 'notification', text: '起身' })
  assert.equal(task.status, 'completed')
  assert.equal(records.get(task.id).status, 'preparing')
  assert.equal(service.error.value, 'REMINDER_STORAGE')
  await service.refresh()
  assert.equal(records.get(task.id).status, 'completed')
  assert.deepEqual(calls.map(call => call[0]), ['wording', 'notify'])
})

test('deleting an elapsed notification clears its OS schedule first and remains retryable on failure', async () => {
  const { service, state, calls } = setup()
  const future = await service.create({ channel: 'notification', text: '休息', at: state.time + 2000 })
  state.time += 2500
  await service.refresh()
  state.cancelFails = true
  await assert.rejects(service.remove(future.id), /REMINDER_DELIVERY/)
  assert.equal(service.tasks.value[0].status, 'completed')
  state.cancelFails = false
  await service.remove(future.id)
  assert.equal(service.tasks.value.length, 0)
  assert.deepEqual(calls.filter(call => call[0] === 'cancel'), [['cancel', future.id], ['cancel', future.id]])

  state.denied = true
  await assert.rejects(service.create({ channel: 'notification', text: '试试', at: state.time + 2000 }))
  state.cancelFails = true
  await service.remove(service.tasks.value[0].id)
  state.denied = false
  const immediate = await service.create({ channel: 'notification', text: '起身' })
  await service.remove(immediate.id)
  assert.equal(service.tasks.value.length, 0)
  assert.deepEqual(calls.filter(call => call[0] === 'cancel'), [['cancel', future.id], ['cancel', future.id]])
})

const local = (year, month, day, hour = 0) => new Date(year, month - 1, day, hour).getTime()
const monthly = { frequency: 'monthly', dayOfMonth: 10, time: '09:00' }
const daily = { frequency: 'daily', time: '12:00' }

test('missed popup occurrences coalesce on reopen, keep one series and resume at the requested time', async () => {
  const { service, restart, state, records } = setup()
  state.time = local(2026, 11, 1)
  state.visible = false
  const task = await service.create({ channel: 'popup', text: '还款', recurrence: monthly })
  assert.equal(task.at, local(2026, 11, 10, 9))
  state.time = local(2027, 2, 23)
  await service.refresh()
  assert.equal(records.get(task.id).at, task.at)
  state.visible = true
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.activePopup.value.id, task.id)
  assert.equal(opened.tasks.value[0].at, local(2027, 3, 10, 9))
  assert.equal(opened.tasks.value[0].status, 'scheduled')
  await opened.dismissPopup()
  await opened.refresh()
  assert.equal(opened.activePopup.value, null)
  state.time = local(2027, 3, 10, 9)
  await opened.refresh()
  assert.equal(opened.activePopup.value.id, task.id)
  assert.equal(records.size, 1)
  await opened.cancel(task.id)
  state.time = local(2028, 3, 10, 9)
  await opened.dismissPopup()
  assert.equal(opened.activePopup.value, null)
})

test('recurring system notifications are registered once; elapsed occurrences advance locally and cancellation stops the series', async () => {
  const { service, restart, state, calls } = setup()
  state.time = local(2026, 11, 1)
  const task = await service.create({ channel: 'notification', text: '还款', recurrence: monthly })
  assert.deepEqual(calls[1], ['schedule', task.id, local(2026, 11, 10, 9), '猫', '还款', true, monthly])
  state.time = local(2027, 2, 15)
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.tasks.value[0].at, local(2027, 3, 10, 9))
  state.time = local(2027, 3, 10, 9)
  await opened.cancel(task.id)
  assert.equal(opened.tasks.value[0].status, 'cancelled')
  assert.deepEqual(calls.map(call => call[0]), ['wording', 'schedule', 'cancel'])
})

test('editing a recurring notification replaces the same OS ID, preserves wording and rejects stale edits', async () => {
  const { service, state, calls } = setup()
  state.time = local(2026, 11, 1)
  const task = await service.create({ channel: 'notification', text: '喝水', recurrence: monthly })
  const input = { channel: 'notification', text: '喝水', recurrence: daily }
  state.denied = true
  await assert.rejects(service.edit(task.id, input, 0), /REMINDER_PERMISSION/)
  assert.deepEqual(service.tasks.value[0].recurrence, monthly)
  assert.equal(service.tasks.value[0].status, 'scheduled')
  state.denied = false
  await service.edit(task.id, input, 0)
  assert.deepEqual(calls.at(-1), ['schedule', task.id, local(2026, 11, 1, 12), '猫', '喝水', true, daily])
  assert.equal(service.tasks.value[0].revision, 1)
  await assert.rejects(service.edit(task.id, input, 0), /REMINDER_STATE/)
  state.cancelFails = true
  await assert.rejects(service.edit(task.id, { ...input, channel: 'popup' }, 1), /REMINDER_DELIVERY/)
  assert.equal(service.tasks.value[0].channel, 'notification')
  state.cancelFails = false
  await service.edit(task.id, { ...input, channel: 'popup' }, 1)
  assert.deepEqual(calls.at(-1), ['cancel', task.id])
  assert.equal(service.tasks.value[0].channel, 'popup')
  assert.equal(calls.filter(call => call[0] === 'wording').length, 1)
  // Convert the same series back to a once-only system notification.
  const at = local(2026, 11, 11, 8)
  await service.edit(task.id, { channel: 'notification', text: '换个事项', at }, 2)
  assert.deepEqual(calls.at(-1), ['schedule', task.id, at, '猫', '换个事项', true])
  assert.equal(service.tasks.value[0].recurrence, undefined)
  state.time = at
  await service.refresh()
  assert.equal(service.tasks.value[0].status, 'completed')
  assert.equal(service.activePopup.value, null)
})

test('interrupted edits recover under the original OS ID and a passed first occurrence does not end the series', async () => {
  const { service, state, restart, records, calls } = setup()
  state.time = local(2026, 11, 1)
  const task = await service.create({ channel: 'notification', text: '还款', recurrence: monthly })
  const pending = { ...task, recurrence: daily, at: local(2026, 11, 1, 12), channel: 'notification' }
  records.set(task.id, { ...task, status: 'editing', pendingEdit: pending })
  state.time = local(2027, 2, 10)
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.tasks.value[0].status, 'scheduled')
  assert.equal(opened.tasks.value[0].pendingEdit, undefined)
  assert.equal(opened.tasks.value[0].revision, 1)
  assert.deepEqual(calls.at(-1), ['schedule', task.id, local(2027, 2, 10, 12), '猫', '还款', false, daily])
  await opened.cancel(task.id)
  assert.deepEqual(calls.at(-1), ['cancel', task.id])
})

test('moving west does not repeat a consumed local date, and a late popup leaves a later occurrence today intact', async () => {
  const original = process.env.TZ
  try {
    process.env.TZ = 'Asia/Hong_Kong'
    const { service, state } = setup()
    state.time = local(2026, 11, 20)
    await service.create({ channel: 'popup', text: '吃午饭', recurrence: daily })
    state.time = local(2026, 11, 21, 11)
    await service.refresh()
    assert.equal(service.activePopup.value.text, '吃午饭')
    assert.equal(service.tasks.value[0].at, local(2026, 11, 21, 12))
    await service.dismissPopup()
    state.time = local(2026, 11, 21, 12)
    await service.refresh()
    assert.equal(service.tasks.value[0].lastLocalDay, '2026-11-21')
    await service.dismissPopup()
    process.env.TZ = 'America/Los_Angeles'
    await service.refresh()
    assert.equal(service.tasks.value[0].at, local(2026, 11, 22, 12))
    state.time = local(2026, 11, 21, 12)
    await service.refresh()
    assert.equal(service.activePopup.value, null)
    state.time = local(2026, 11, 22, 12)
    await service.refresh()
    assert.equal(service.activePopup.value.text, '吃午饭')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('an interrupted OS replacement that cannot be verified stays cancellable and may be retried', async () => {
  const { service, state, records, restart, calls } = setup()
  state.time = local(2026, 11, 1)
  const task = await service.create({ channel: 'popup', text: '', recurrence: monthly })
  records.set(task.id, { ...task, status: 'editing', pendingEdit: { ...task, channel: 'notification' } })
  state.denied = true
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.tasks.value[0].status, 'editing')
  assert.equal(opened.tasks.value[0].error, 'REMINDER_PERMISSION')
  state.cancelFails = true
  await assert.rejects(opened.cancel(task.id), /REMINDER_DELIVERY/)
  assert.equal(opened.tasks.value[0].status, 'editing')
  state.cancelFails = false
  await opened.cancel(task.id)
  assert.equal(opened.tasks.value[0].status, 'cancelled')
  assert.equal(opened.tasks.value[0].pendingEdit, undefined)
  assert.deepEqual(calls.at(-1), ['cancel', task.id])
})

test('an interval popup repeats within one day and coalesces missed periods without moving the anchor', async () => {
  const { service, state, restart } = setup()
  const interval = createIntervalRecurrence(10, state.time)
  const task = await service.create({ channel: 'popup', text: '休息', recurrence: interval })
  assert.equal(task.at, interval.anchorAt)
  state.time = task.at
  await service.refresh()
  assert.equal(service.activePopup.value.at, task.at)
  assert.equal(service.tasks.value[0].at, task.at + 600_000)
  await service.dismissPopup()
  state.time += 23 * 60_000
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.activePopup.value.at, task.at + 1_200_000)
  await opened.dismissPopup()
  assert.equal(opened.activePopup.value, null)
  assert.equal(opened.tasks.value[0].at, task.at + 1_800_000)
  await opened.edit(task.id, { channel: 'popup', text: '休息一下', recurrence: interval })
  assert.deepEqual(opened.tasks.value[0].recurrence, interval)
  assert.equal(opened.tasks.value[0].at, task.at + 1_800_000)
})

test('random meal popups expire when outside their window and catch up once while still inside it', async () => {
  const { service, state, restart } = setup()
  const lunch = createRandomWindowRecurrence('11:30', '13:00', 42)
  state.time = local(2026, 11, 22)
  const task = await service.create({ channel: 'popup', text: '吃饭', recurrence: lunch })
  state.visible = false
  state.time = local(2026, 11, 22, 21)
  await service.refresh()
  state.visible = true
  const opened = restart()
  await opened.refresh()
  assert.equal(opened.activePopup.value, null)
  const tomorrow = opened.tasks.value[0].at
  assert.equal(tomorrow, nextReminderOccurrence(lunch, state.time))
  state.time = local(2026, 11, 23, 13)
  await opened.refresh()
  assert.equal(opened.activePopup.value.id, task.id)
  assert.equal(opened.activePopup.value.at, tomorrow)
  state.time += 60_000
  await opened.refresh()
  assert.equal(opened.activePopup.value, null)
  assert.deepEqual(opened.tasks.value[0].recurrence, lunch)
})

test('adjacent overnight windows that land on the same date are each delivered once', async () => {
  const { service, state, calls } = setup()
  const night = createRandomWindowRecurrence('23:00', '01:00', 42)
  state.time = local(2026, 11, 24, 19)
  const task = await service.create({ channel: 'popup', text: '睡觉', recurrence: night })
  assert.equal(task.at, new Date(2026, 10, 25, 0, 15).getTime())
  state.time = task.at
  await service.refresh()
  assert.equal(service.tasks.value[0].lastLocalDay, '2026-11-24')
  await service.dismissPopup()
  const next = new Date(2026, 10, 25, 23, 28).getTime()
  assert.equal(service.tasks.value[0].at, next)
  await service.edit(task.id, { channel: 'notification', text: '睡觉', recurrence: night })
  assert.deepEqual(calls.at(-1), ['schedule', task.id, next, '猫', '睡觉', true, night])
  state.time = next
  await service.refresh()
  assert.equal(service.tasks.value[0].lastLocalDay, '2026-11-25')
  await service.cancel(task.id)
  assert.deepEqual(calls.at(-1), ['cancel', task.id])
})
