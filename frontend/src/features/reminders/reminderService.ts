import { readonly, ref, shallowRef } from 'vue'
import type { PetCharacter } from '../pets/catalog.ts'

export type ReminderChannel = 'popup' | 'notification'
export type ReminderStatus = 'preparing' | 'scheduled' | 'completed' | 'cancelling' | 'cancelled' | 'failed'

export interface ReminderInput {
  channel: ReminderChannel
  text: string
  at?: number
  pet?: PetCharacter
}

interface ReminderWording {
  petId: string
  petName: string
  message: string
}

export interface ReminderTask extends ReminderWording {
  id: number
  channel: ReminderChannel
  text: string
  createdAt: number
  at: number
  scheduled: boolean
  status: ReminderStatus
  error?: string
}

export interface ReminderStore {
  list(): Promise<ReminderTask[]>
  add(task: Omit<ReminderTask, 'id'>): Promise<ReminderTask>
  transition(id: number, from: ReminderStatus, to: ReminderStatus, error?: string): Promise<ReminderTask | null>
  remove(id: number, from: ReminderStatus): Promise<boolean>
}

interface ReminderServices {
  store: ReminderStore
  prepareText(text: string, pet?: PetCharacter, at?: number): Promise<ReminderWording>
  delivery: {
    notify(id: number, title: string, body: string): Promise<void>
    schedule(id: number, at: number, title: string, body: string, requestPermission?: boolean): Promise<void>
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

export function createReminderService(services: ReminderServices) {
  const { store, delivery, now, visible } = services
  const tasks = shallowRef<ReminderTask[]>([])
  const activePopup = shallowRef<ReminderTask | null>(null)
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

  async function transition(task: ReminderTask, status: ReminderStatus, reason?: string) {
    const updated = await store.transition(task.id, task.status, status, reason)
    if (!updated) throw new Error('REMINDER_STATE')
    services.onChange?.()
    return updated
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
    if (recovering && (!task.scheduled || task.at <= now())) {
      return transition(task, 'failed', 'REMINDER_INTERRUPTED')
    }
    const future = task.scheduled && task.at > now()
    try {
      if (future) await delivery.schedule(task.id, task.at, task.petName, task.message, !recovering)
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
      await transition(task, 'scheduled', reason)
      throw new Error(reason)
    }
    return transition(task, 'cancelled')
  }

  async function reconcile() {
    const records = (await store.list()).sort((a, b) => a.at - b.at || a.id - b.id)
    for (const task of records) {
      if (task.status === 'preparing') await register(task, true)
      else if (task.status === 'cancelling') await finishCancellation(task)
      else if (task.status === 'scheduled' && task.at <= now()) {
        if (task.channel === 'notification') {
          // Already handed to the OS. Reaching its deadline never sends it again.
          await transition(task, 'completed')
        } else if (visible() && !activePopup.value) {
          activePopup.value = await transition(task, 'completed')
        }
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
    if (input.channel !== 'popup' && input.channel !== 'notification') throw new Error('REMINDER_STATE')
    if (typeof input.text !== 'string' || Array.from(input.text.trim()).length > 300) throw new Error('REMINDER_INVALID_TEXT')
    const text = input.text.trim()
    const createdAt = now()
    const at = input.at ?? createdAt
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()) || (input.at !== undefined && at <= createdAt)) {
      throw new Error('REMINDER_INVALID_TIME')
    }
    const wording = await services.prepareText(text, input.pet, input.at)
    return run(async () => {
      const task = await store.add({ channel: input.channel, text, ...wording, createdAt, at,
        scheduled: input.at !== undefined, status: input.channel === 'popup' ? 'scheduled' : 'preparing' })
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

  function cancel(id: number): Promise<void> {
    return run(async () => {
      const task = (await store.list()).find(item => item.id === id)
      if (!task || task.status !== 'scheduled') throw new Error('REMINDER_STATE')
      try {
        if (task.channel === 'popup') await transition(task, 'cancelled')
        else if (task.at > now()) await finishCancellation(await transition(task, 'cancelling'))
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

  function dismissPopup() {
    activePopup.value = null
    return refresh()
  }

  return { tasks: readonly(tasks), ready: readonly(ready), error: readonly(error), activePopup: readonly(activePopup),
    refresh, create, cancel, remove, dismissPopup }
}
