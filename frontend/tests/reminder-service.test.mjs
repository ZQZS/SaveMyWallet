import assert from 'node:assert/strict'
import test from 'node:test'
import { createReminderService } from '../src/features/reminders/reminderService.ts'

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
    async transition(id, from, to, error) {
      const current = records.get(id)
      if (current?.status !== from) return null
      const item = { ...current, status: to, error }
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
      async notify(...args) { calls.push(['notify', ...args]) },
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
  const immediate = await service.create({ channel: 'notification', text: '起身' })
  await service.remove(immediate.id)
  assert.equal(service.tasks.value.length, 0)
  assert.deepEqual(calls.filter(call => call[0] === 'cancel'), [['cancel', future.id], ['cancel', future.id]])
})
