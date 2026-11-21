import { watch } from 'vue'
import { nativeDelivery } from './nativeDelivery.ts'
import { createReminderService } from './reminderService.ts'
import { reminderStore } from './reminderStore.ts'
import { prepareReminderText } from './reminderWording.ts'
import { reminderWindowExpiresAt } from './recurrence.ts'

let broadcasts: BroadcastChannel | undefined
const visible = () => document.visibilityState === 'visible'
const reminders = createReminderService({
  store: reminderStore, delivery: nativeDelivery, prepareText: prepareReminderText, now: Date.now, visible,
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (navigator.locks) return await navigator.locks.request('savemywallet.reminder-delivery', operation)
    return operation()
  },
  onChange: () => broadcasts?.postMessage('changed'),
})

export function useReminders() { return reminders }

export function startReminders() {
  let timer: number | undefined
  let running = true
  const refresh = () => { if (running) void reminders.refresh().then(arm) }
  function arm() {
    window.clearTimeout(timer)
    if (!running) return
    if (reminders.error.value) {
      timer = window.setTimeout(refresh, 30_000)
      return
    }
    const due = reminders.tasks.value.filter(task => task.status === 'scheduled'
      && (task.channel === 'notification' || (visible() && !reminders.activePopup.value)))
    const needsRecovery = reminders.tasks.value.some(task => ['editing', 'preparing', 'cancelling'].includes(task.status))
    const now = Date.now()
    const popup = reminders.activePopup.value
    let delay = Infinity
    if (popup?.recurrence?.frequency === 'randomWindow') {
      delay = Math.max(0, reminderWindowExpiresAt(popup.recurrence, popup.at, now) - now)
    }
    // Re-check periodically for changes to the device clock, including after resume.
    if (needsRecovery) delay = Math.min(delay, 30_000)
    if (due.length) delay = Math.min(delay, 60_000)
    for (const task of due) delay = Math.min(delay, Math.max(0, task.at - now))
    if (Number.isFinite(delay)) timer = window.setTimeout(refresh, delay)
  }
  const stopWatch = watch([reminders.tasks, reminders.activePopup, reminders.error], arm)
  if (typeof BroadcastChannel !== 'undefined') {
    broadcasts = new BroadcastChannel('savemywallet.reminders')
    broadcasts.onmessage = refresh
  }
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  refresh()
  return () => {
    running = false
    stopWatch()
    window.clearTimeout(timer)
    broadcasts?.close()
    broadcasts = undefined
    document.removeEventListener('visibilitychange', refresh)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('pageshow', refresh)
  }
}
