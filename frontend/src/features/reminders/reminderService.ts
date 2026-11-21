import { computed, readonly, ref, shallowRef } from 'vue'
import type { PetCharacter } from '../pets/catalog.ts'
import { inReminderWindow, nextReminderOccurrence, parseReminderRecurrence, previousReminderOccurrence,
  reminderOccurrenceDay, type ReminderRecurrence } from './recurrence.ts'

export type ReminderChannel = 'popup' | 'notification'
export type ReminderStatus = 'preparing' | 'scheduled' | 'editing' | 'completed' | 'cancelling' | 'cancelled' | 'failed'
  | 'disabled' | 'disabling' | 'enabling' | 'deleting'

export interface ReminderInput {
  channel: ReminderChannel
  text: string
  at?: number
  recurrence?: ReminderRecurrence
  pet?: PetCharacter
}

interface ReminderWording {
  petId: string
  petName: string
  message: string
}

interface ReminderPlan extends ReminderWording {
  channel: ReminderChannel
  text: string
  at: number
  scheduled: boolean
  recurrence?: ReminderRecurrence
  recurrenceAfter?: number
  timeZone?: string
  lastLocalDay?: string
}

export interface ReminderTask extends ReminderPlan {
  id: number
  createdAt: number
  status: ReminderStatus
  error?: string
  revision?: number
  pendingEdit?: ReminderPlan
}

export type ReminderChanges = Partial<ReminderPlan> & Pick<Partial<ReminderTask>, 'pendingEdit' | 'revision'>

export interface ReminderStore {
  list(): Promise<ReminderTask[]>
  add(task: Omit<ReminderTask, 'id'>): Promise<ReminderTask>
  transition(id: number, from: ReminderStatus, to: ReminderStatus, error?: string, changes?: ReminderChanges,
    expected?: { at: number; revision: number }): Promise<ReminderTask | null>
  remove(id: number, from: ReminderStatus, expectedRevision?: number): Promise<boolean>
}

interface ReminderServices {
  store: ReminderStore
  prepareText(text: string, pet?: PetCharacter, at?: number): Promise<ReminderWording>
  delivery: {
    notify(id: number, title: string, body: string): Promise<void>
    schedule(id: number, at: number, title: string, body: string, requestPermission?: boolean, recurrence?: ReminderRecurrence): Promise<void>
    cancel(id: number): Promise<void>
  }
  now(): number
  visible(): boolean
  exclusive?<T>(operation: () => Promise<T>): Promise<T>
  onChange?(): void
}

function errorCode(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /^(?:REMINDER_[A-Z_]+|NATIVE_ONLY)$/.test(message) ? message : fallback
}

function nextUnseen(recurrence: ReminderRecurrence, after: number, lastLocalDay?: string) {
  let next = nextReminderOccurrence(recurrence, after)
  // Travelling west can put the same local date and time in the future again.
  if (recurrence.frequency !== 'interval' && lastLocalDay) {
    while (reminderOccurrenceDay(recurrence, next)! <= lastLocalDay) next = nextReminderOccurrence(recurrence, next)
  }
  return next
}

function inCurrentZone(plan: ReminderPlan, timeZone: string) {
  if (!plan.recurrence || plan.recurrence.frequency === 'interval' || plan.timeZone === timeZone) return plan
  const at = nextUnseen(plan.recurrence, plan.recurrenceAfter ?? plan.at - 1, plan.lastLocalDay)
  return { ...plan, at, timeZone }
}

function planInput(input: ReminderInput, now: number, allowPastOnce = false) {
  if (input.channel !== 'popup' && input.channel !== 'notification') throw new Error('REMINDER_STATE')
  if (typeof input.text !== 'string' || Array.from(input.text.trim()).length > 300) throw new Error('REMINDER_INVALID_TEXT')
  const recurrence = input.recurrence === undefined ? undefined : parseReminderRecurrence(input.recurrence)
  const first = recurrence ? nextReminderOccurrence(recurrence, now) : now
  const at = input.at ?? first
  const scheduled = input.at !== undefined || recurrence !== undefined
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())
      || (scheduled && at <= now && !(allowPastOnce && !recurrence))
      || (recurrence && nextReminderOccurrence(recurrence, at - 1) !== at)) throw new Error('REMINDER_INVALID_TIME')
  return { channel: input.channel, text: input.text.trim(), at, scheduled, recurrence, lastLocalDay: undefined,
    // Anchor the series to its first occurrence when an explicit future start skips earlier matches.
    recurrenceAfter: recurrence ? (at === first ? now : at - 1) : undefined,
    timeZone: recurrence ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined }
}

function inactive(task: ReminderTask) {
  return ['disabled', 'completed', 'cancelled', 'failed'].includes(task.status)
}

function mayHaveNativeAlarm(task: ReminderTask) {
  if (task.pendingEdit?.channel === 'notification') return true
  if (task.channel !== 'notification' || !task.scheduled) return false
  // An elapsed one-shot may still be waiting for the OS to wake the device.
  return !['disabled', 'cancelled', 'failed'].includes(task.status) || task.error === 'REMINDER_INTERRUPTED'
}

export function createReminderService(services: ReminderServices) {
  const { store, delivery, now, visible } = services
  const tasks = shallowRef<ReminderTask[]>([])
  const activePopup = shallowRef<ReminderTask | null>(null)
  const testPopup = shallowRef<ReminderTask | null>(null)
  const shownPopup = computed(() => activePopup.value ?? testPopup.value)
  const ready = ref(false)
  const error = ref('')
  const handedOff = new Map<number, 'scheduled' | 'completed'>()
  let pending = Promise.resolve()

  // Serialize OS registration/cancellation with recovery. The desktop adapter
  // also acquires an origin-wide Web Lock when another app window is running.
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(() => services.exclusive ? services.exclusive(operation) : operation())
    pending = result.then(() => {}, () => {})
    return result
  }

  async function transition(task: ReminderTask, status: ReminderStatus, reason?: string, changes?: ReminderChanges) {
    const updated = await store.transition(task.id, task.status, status, reason, changes, { at: task.at, revision: task.revision ?? 0 })
    if (!updated) throw new Error('REMINDER_STATE')
    services.onChange?.()
    return updated
  }

  function schedule(id: number, plan: ReminderPlan, requestPermission: boolean) {
    if (plan.recurrence) return delivery.schedule(id, plan.at, plan.petName, plan.message, requestPermission, plan.recurrence)
    return delivery.schedule(id, plan.at, plan.petName, plan.message, requestPermission)
  }

  async function reload() {
    const records = (await store.list()).sort((a, b) => b.id - a.id)
    closeObsoletePopup(records)
    tasks.value = records
    ready.value = true
    error.value = ''
  }

  function closeObsoletePopup(records: ReminderTask[]) {
    const open = activePopup.value
    if (!open) return
    const current = records.find(task => task.id === open.id)
    if (!current || current.channel !== 'popup' || !['completed', 'scheduled'].includes(current.status)
        || (current.revision ?? 0) !== (open.revision ?? 0)) activePopup.value = null
  }

  async function checkedTask(id: number, expectedRevision?: number) {
    const task = (await store.list()).find(record => record.id === id)
    if (!task || (expectedRevision !== undefined && (task.revision ?? 0) !== expectedRevision)) throw new Error('REMINDER_STATE')
    return task
  }

  async function erase(task: ReminderTask) {
    if (!await store.remove(task.id, task.status, task.revision ?? 0)) throw new Error('REMINDER_STATE')
    handedOff.delete(task.id)
    services.onChange?.()
  }

  async function finishStop(task: ReminderTask, recovering = false, rollback?: ReminderStatus) {
    try {
      await delivery.cancel(task.id)
    } catch (cause) {
      const reason = errorCode(cause, 'REMINDER_DELIVERY')
      // Keep a deletion intent, including on a failed recovery. The OS may still have the alarm.
      const status = rollback ?? task.status
      if (task.status !== status || task.error !== reason) await transition(task, status, reason)
      if (recovering) return
      throw new Error(reason)
    }
    if (task.status === 'deleting') await erase(task)
    else await transition(task, task.status === 'cancelling' ? 'cancelled' : 'disabled', undefined, { pendingEdit: undefined })
  }

  function nextActivation(plan: ReminderPlan, time: number): Pick<ReminderPlan, 'at' | 'recurrenceAfter' | 'timeZone'> {
    if (!plan.recurrence) {
      if (plan.at <= time) throw new Error('REMINDER_EXPIRED')
      return { at: plan.at }
    }
    // Retain the original first occurrence if it is still in the future, including
    // schedules which explicitly start at a later matching date.
    const after = Math.max(time, plan.recurrenceAfter ?? plan.at - 1)
    return { at: nextUnseen(plan.recurrence, after, plan.lastLocalDay), recurrenceAfter: after,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }

  async function finishEnable(task: ReminderTask, recovering = false) {
    const time = now()
    // Enabling is durable before crossing the native bridge. A restart must not replay
    // a one-shot that might already have fired, or leave an alarm armed but marked off.
    if (!task.recurrence && task.at <= time) {
      await finishStop(await transition(task, 'disabling'), true)
      if (!recovering) throw new Error('REMINDER_EXPIRED')
      return
    }
    const next = nextActivation(task, time)
    try {
      await schedule(task.id, { ...task, ...next }, !recovering)
    } catch (cause) {
      const reason = errorCode(cause, 'REMINDER_DELIVERY')
      if (!recovering || task.error !== reason) await transition(task, recovering ? 'enabling' : 'disabled', reason)
      if (!recovering) throw new Error(reason)
      return
    }
    await transition(task, 'scheduled', undefined, next)
  }

  async function enable(task: ReminderTask, replacement?: ReminderPlan) {
    const plan = replacement ?? task
    const next = nextActivation(plan, now())
    const native = plan.channel === 'notification'
    const updated = await transition(task, native ? 'enabling' : 'scheduled', undefined, {
      ...replacement, ...next, revision: (task.revision ?? 0) + 1,
    })
    if (native) await finishEnable(updated)
  }

  async function register(task: ReminderTask, recovering = false) {
    const accepted = handedOff.get(task.id)
    if (accepted) {
      const updated = await transition(task, accepted)
      handedOff.delete(task.id)
      return updated
    }
    // Replaying an immediate notification after a crash could deliver it twice.
    const local = inCurrentZone(task, Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (local !== task) task = await transition(task, 'preparing', undefined, { at: local.at, timeZone: local.timeZone })
    if (task.recurrence && task.at <= now()) {
      const after = now()
      task = await transition(task, 'preparing', undefined, { at: nextUnseen(task.recurrence, after, task.lastLocalDay), recurrenceAfter: after })
    }
    if (recovering && !task.recurrence && (!task.scheduled || task.at <= now())) {
      return transition(task, 'failed', 'REMINDER_INTERRUPTED')
    }
    const future = Boolean(task.recurrence) || (task.scheduled && task.at > now())
    try {
      if (future) await schedule(task.id, task, !recovering)
      else await delivery.notify(task.id, task.petName, task.message)
    } catch (cause) {
      const reason = errorCode(cause, 'REMINDER_DELIVERY')
      const failed = await transition(task, 'failed', reason)
      if (recovering) return failed
      throw new Error(reason)
    }
    const status = future ? 'scheduled' : 'completed'
    handedOff.set(task.id, status)
    try {
      const updated = await transition(task, status)
      handedOff.delete(task.id)
      return updated
    } catch (cause) {
      // The OS has accepted this ID. Recover the local receipt without
      // prompting the user to submit a second notification.
      error.value = errorCode(cause, 'REMINDER_STORAGE')
      if (recovering) throw cause
      return { ...task, status } as ReminderTask
    }
  }

  // Keep the previous plan and the requested replacement until the OS operation succeeds.
  // Scheduling by the same ID and cancelling by ID are idempotent across a process restart.
  async function finishEdit(task: ReminderTask, recovering = false) {
    let plan = task.pendingEdit
    if (!plan) throw new Error('REMINDER_STATE')
    plan = inCurrentZone(plan, Intl.DateTimeFormat().resolvedOptions().timeZone)
    let status: ReminderStatus = 'scheduled'
    let failure: string | undefined
    try {
      if (plan.channel === 'notification') {
        const time = now()
        if (plan.recurrence && plan.at <= time) {
          plan = { ...plan, at: nextUnseen(plan.recurrence, time, plan.lastLocalDay), recurrenceAfter: time }
        }
        if (plan.at > time) await schedule(task.id, plan, !recovering)
        else if (recovering) {
          // A one-shot replacement may have fired before its receipt was saved.
          // Clear any surviving old registration and never post another notification.
          await delivery.cancel(task.id)
          status = 'failed'
          failure = 'REMINDER_INTERRUPTED'
        } else throw new Error('REMINDER_INVALID_TIME')
      } else if (task.channel === 'notification') {
        await delivery.cancel(task.id)
      }
    } catch (cause) {
      const reason = errorCode(cause, 'REMINDER_DELIVERY')
      // The replacement may already have been accepted before the previous
      // process exited. Keep its intent retryable until the OS confirms it.
      if (recovering) return task.error === reason ? task : transition(task, 'editing', reason)
      // A rejected replacement leaves the previous OS schedule intact.
      await transition(task, 'scheduled', reason, { pendingEdit: undefined })
      throw new Error(reason)
    }
    return transition(task, status, failure, { ...plan, pendingEdit: undefined, revision: (task.revision ?? 0) + 1 })
  }

  async function reconcile() {
    const records = (await store.list()).sort((a, b) => a.at - b.at || a.id - b.id)
    closeObsoletePopup(records)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const open = activePopup.value
    if (open?.recurrence?.frequency === 'randomWindow' && !inReminderWindow(open.recurrence, open.at, now())) {
      activePopup.value = null
    }
    for (let task of records) {
      if (task.status === 'deleting' || task.status === 'disabling' || task.status === 'cancelling') { await finishStop(task, true); continue }
      if (task.status === 'enabling') { await finishEnable(task, true); continue }
      if (task.status === 'preparing') { await register(task, true); continue }
      if (task.status === 'editing') { await finishEdit(task, true); continue }
      if (task.status !== 'scheduled') continue
      const local = inCurrentZone(task, zone)
      if (local !== task) task = await transition(task, 'scheduled', undefined, { at: local.at, timeZone: zone })
      const time = now()
      if (task.at > time || (task.channel === 'popup' && (!visible() || shownPopup.value))) continue
      if (task.recurrence) {
        // A recurring system notification is already owned by the OS. For a popup
        // claim the entire overdue interval before displaying one catch-up message.
        const latest = previousReminderOccurrence(task.recurrence, time)
        const lastLocalDay = reminderOccurrenceDay(task.recurrence, latest)
        await transition(task, 'scheduled', undefined, { at: nextUnseen(task.recurrence, time, lastLocalDay), recurrenceAfter: time, lastLocalDay })
        const withinWindow = task.recurrence.frequency !== 'randomWindow' || inReminderWindow(task.recurrence, latest, time)
        if (task.channel === 'popup' && withinWindow) activePopup.value = { ...task, at: latest }
      } else {
        const completed = await transition(task, 'completed')
        if (task.channel === 'popup') activePopup.value = completed
      }
    }
    await reload()
  }

  function refresh() {
    return run(reconcile).catch(cause => {
      ready.value = true
      error.value = errorCode(cause, 'REMINDER_STORAGE')
    })
  }

  async function create(input: ReminderInput): Promise<ReminderTask> {
    const createdAt = now()
    const plan = planInput(input, createdAt)
    const wording = await services.prepareText(plan.text, input.pet, plan.scheduled ? plan.at : undefined)
    return run(async () => {
      const task = await store.add({ ...plan, ...wording, createdAt, status: plan.channel === 'popup' ? 'scheduled' : 'preparing' })
      services.onChange?.()
      try {
        if (task.channel === 'notification') return await register(task)
        // The popup task is already durable. On a list/read failure the next
        // refresh will deliver it; submitting a new task would duplicate it.
        await reconcile().catch(cause => { error.value = errorCode(cause, 'REMINDER_STORAGE') })
        return tasks.value.find(item => item.id === task.id) ?? task
      } finally {
        // A successful OS handoff may outlive a failed list refresh.
        if (task.channel === 'notification') {
          await reload().catch(cause => { error.value = errorCode(cause, 'REMINDER_STORAGE') })
          if (handedOff.has(task.id)) error.value = 'REMINDER_STORAGE'
        }
      }
    })
  }

  async function edit(id: number, input: ReminderInput, expectedRevision?: number, enableAfterSave = false) {
    const previous = await checkedTask(id, expectedRevision)
    const off = inactive(previous)
    if (!previous.scheduled || (!off && previous.status !== 'scheduled')) throw new Error('REMINDER_STATE')
    const plan = planInput(input, now(), off && !enableAfterSave)
    if (!plan.scheduled) throw new Error('REMINDER_INVALID_TIME')
    const { petId, petName, message } = previous
    const wording = previous.text === plan.text ? { petId, petName, message } : await services.prepareText(plan.text, input.pet, plan.at)
    return run(async () => {
      const current = await checkedTask(id, previous.revision ?? 0)
      if (current.status !== previous.status) throw new Error('REMINDER_STATE')
      const pendingEdit: ReminderPlan = { ...plan, ...wording }
      if (current.lastLocalDay && plan.recurrence && JSON.stringify(current.recurrence) === JSON.stringify(plan.recurrence)) {
        pendingEdit.lastLocalDay = current.lastLocalDay
        pendingEdit.at = nextUnseen(plan.recurrence, plan.at - 1, current.lastLocalDay)
      }
      try {
        if (off) {
          if (mayHaveNativeAlarm(current)) await delivery.cancel(id)
          if (enableAfterSave) await enable(current, pendingEdit)
          else await transition(current, 'disabled', undefined, { ...pendingEdit, revision: (current.revision ?? 0) + 1 })
        } else {
          const task = await transition(current, 'editing', undefined, { pendingEdit })
          await finishEdit(task)
        }
      } finally { await reload() }
    })
  }

  function setEnabled(id: number, enabled: boolean, expectedRevision?: number): Promise<void> {
    return run(async () => {
      const task = await checkedTask(id, expectedRevision)
      if (!task.scheduled) throw new Error('REMINDER_STATE')
      try {
        if (enabled) {
          if (task.status === 'scheduled') return
          if (!inactive(task)) throw new Error('REMINDER_STATE')
          await enable(task)
        } else {
          if (inactive(task)) return
          if (task.status !== 'scheduled' && !(task.error && ['editing', 'enabling', 'disabling'].includes(task.status))) {
            throw new Error('REMINDER_STATE')
          }
          const changes = { revision: (task.revision ?? 0) + 1 }
          if (mayHaveNativeAlarm(task)) {
            const stopping = await transition(task, 'disabling', undefined, changes)
            const rollback = task.status === 'scheduled' || task.status === 'editing' ? task.status : undefined
            await finishStop(stopping, false, rollback)
          } else await transition(task, 'disabled', undefined, { ...changes, pendingEdit: undefined })
        }
      } finally { await reload() }
    })
  }

  function cancel(id: number): Promise<void> {
    return run(async () => {
      const task = (await store.list()).find(item => item.id === id)
      if (!task || (task.status !== 'scheduled' && !(task.status === 'editing' && task.error))) throw new Error('REMINDER_STATE')
      try {
        if (task.pendingEdit) await finishStop(await transition(task, 'cancelling'), false, 'editing')
        else if (task.channel === 'popup') await transition(task, 'cancelled')
        else if (task.recurrence || task.at > now()) await finishStop(await transition(task, 'cancelling'), false, 'scheduled')
        else {
          await transition(task, 'completed')
          throw new Error('REMINDER_STATE')
        }
      } finally { await reload() }
    })
  }

  function remove(id: number, expectedRevision?: number): Promise<void> {
    return run(async () => {
      const task = await checkedTask(id, expectedRevision)
      try {
        if (task.status === 'deleting') { await finishStop(task); return }
        if (!inactive(task) && task.status !== 'scheduled' && !task.error) throw new Error('REMINDER_STATE')
        if (mayHaveNativeAlarm(task)) {
          await finishStop(await transition(task, 'deleting', undefined, { revision: (task.revision ?? 0) + 1 }))
        } else await erase(task)
      } finally { await reload() }
    })
  }

  async function test({ channel, text, pet }: Pick<ReminderInput, 'channel' | 'text' | 'pet'>) {
    const createdAt = now()
    const plan = planInput({ channel, text }, createdAt)
    const wording = await services.prepareText(plan.text, pet)
    // IndexedDB assigns positive task IDs. Zero identifies only the transient test.
    if (channel === 'notification') await delivery.notify(0, wording.petName, wording.message)
    else testPopup.value = { ...plan, ...wording, id: 0, createdAt, status: 'completed' }
  }

  function dismissPopup() {
    if (activePopup.value) activePopup.value = null
    else testPopup.value = null
    return refresh()
  }

  return { tasks: readonly(tasks), ready: readonly(ready), error: readonly(error), activePopup: readonly(shownPopup),
    list: () => store.list(), refresh, create, edit, cancel, setEnabled, remove, test, dismissPopup }
}
