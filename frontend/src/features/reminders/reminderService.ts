import { computed, readonly, ref, shallowRef } from 'vue'
import type { PetCharacter } from '../pets/catalog.ts'
import { inReminderWindow, nextReminderOccurrence, parseReminderRecurrence, previousReminderOccurrence,
  reminderOccurrenceDay, type ReminderRecurrence } from './recurrence.ts'

export type ReminderChannel = 'popup' | 'notification'
export type ReminderStatus = 'preparing' | 'scheduled' | 'editing' | 'completed' | 'cancelling' | 'cancelled' | 'failed'

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
  remove(id: number, from: ReminderStatus): Promise<boolean>
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

function planInput(input: ReminderInput, now: number) {
  if (input.channel !== 'popup' && input.channel !== 'notification') throw new Error('REMINDER_STATE')
  if (typeof input.text !== 'string' || Array.from(input.text.trim()).length > 300) throw new Error('REMINDER_INVALID_TEXT')
  const recurrence = input.recurrence === undefined ? undefined : parseReminderRecurrence(input.recurrence)
  const first = recurrence ? nextReminderOccurrence(recurrence, now) : now
  const at = input.at ?? first
  const scheduled = input.at !== undefined || recurrence !== undefined
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()) || (scheduled && at <= now)
      || (recurrence && nextReminderOccurrence(recurrence, at - 1) !== at)) throw new Error('REMINDER_INVALID_TIME')
  return { channel: input.channel, text: input.text.trim(), at, scheduled, recurrence, lastLocalDay: undefined,
    // Anchor the series to its first occurrence when an explicit future start skips earlier matches.
    recurrenceAfter: recurrence ? (at === first ? now : at - 1) : undefined,
    timeZone: recurrence ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined }
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
    tasks.value = (await store.list()).sort((a, b) => b.id - a.id)
    ready.value = true
    error.value = ''
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

  async function finishCancellation(task: ReminderTask) {
    try {
      await delivery.cancel(task.id)
    } catch (cause) {
      const reason = errorCode(cause, 'REMINDER_DELIVERY')
      // The OS may still deliver this schedule. Keep it available to cancel.
      await transition(task, task.pendingEdit ? 'editing' : 'scheduled', reason)
      throw new Error(reason)
    }
    return transition(task, 'cancelled', undefined, { pendingEdit: undefined })
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
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const open = activePopup.value
    if (open?.recurrence?.frequency === 'randomWindow' && !inReminderWindow(open.recurrence, open.at, now())) {
      activePopup.value = null
    }
    for (let task of records) {
      if (task.status === 'preparing') { await register(task, true); continue }
      if (task.status === 'cancelling') { await finishCancellation(task); continue }
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

  async function edit(id: number, input: ReminderInput, expectedRevision?: number) {
    const previous = (await store.list()).find(item => item.id === id)
    if (!previous || previous.status !== 'scheduled' || !previous.scheduled
        || (expectedRevision !== undefined && expectedRevision !== (previous.revision ?? 0))) throw new Error('REMINDER_STATE')
    const plan = planInput(input, now())
    if (!plan.scheduled) throw new Error('REMINDER_INVALID_TIME')
    const { petId, petName, message } = previous
    const wording = previous.text === plan.text ? { petId, petName, message } : await services.prepareText(plan.text, input.pet, plan.at)
    return run(async () => {
      const current = (await store.list()).find(item => item.id === id)
      if (!current || current.status !== 'scheduled' || (current.revision ?? 0) !== (previous.revision ?? 0)) throw new Error('REMINDER_STATE')
      const pendingEdit: ReminderPlan = { ...plan, ...wording }
      if (current.lastLocalDay && plan.recurrence && JSON.stringify(current.recurrence) === JSON.stringify(plan.recurrence)) {
        pendingEdit.lastLocalDay = current.lastLocalDay
        pendingEdit.at = nextUnseen(plan.recurrence, plan.at - 1, current.lastLocalDay)
      }
      try {
        const task = await transition(current, 'editing', undefined, { pendingEdit })
        await finishEdit(task)
      } finally { await reload() }
    })
  }

  function cancel(id: number): Promise<void> {
    return run(async () => {
      const task = (await store.list()).find(item => item.id === id)
      if (!task || (task.status !== 'scheduled' && !(task.status === 'editing' && task.error))) throw new Error('REMINDER_STATE')
      try {
        if (task.pendingEdit) await finishCancellation(await transition(task, 'cancelling'))
        else if (task.channel === 'popup') await transition(task, 'cancelled')
        else if (task.recurrence || task.at > now()) await finishCancellation(await transition(task, 'cancelling'))
        else {
          await transition(task, 'completed')
          throw new Error('REMINDER_STATE')
        }
      } finally { await reload() }
    })
  }

  function remove(id: number): Promise<void> {
    return run(async () => {
      const task = (await store.list()).find(item => item.id === id)
      if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error('REMINDER_STATE')
      if (task.channel === 'notification' && task.scheduled && (task.status === 'completed' || task.error === 'REMINDER_INTERRUPTED')) {
        // The scheduled time can precede OS delivery (for example during Android Doze).
        // Keep the history entry available for retry until the native schedule is cleared.
        await delivery.cancel(task.id)
      }
      if (!await store.remove(id, task.status)) throw new Error('REMINDER_STATE')
      services.onChange?.()
      await reload()
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
    refresh, create, edit, cancel, remove, test, dismissPopup }
}
