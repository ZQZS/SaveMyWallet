import { locale, t } from '../../i18n/index.ts'
import { createIntervalRecurrence, createRandomWindowRecurrence, nextReminderOccurrence, parseReminderRecurrence } from './recurrence.ts'
import { formatReminderRecurrence } from './recurrenceFormat.ts'
import type { ReminderInput, ReminderTask } from './reminderService.ts'

const reminderActions = {
  show_pet_popup: { channel: 'popup', scheduled: false },
  send_pet_notification: { channel: 'notification', scheduled: false },
  schedule_pet_popup: { channel: 'popup', scheduled: true },
  schedule_pet_notification: { channel: 'notification', scheduled: true },
} as const

export type ReminderActionName = keyof typeof reminderActions
export type CreateReminder = (input: ReminderInput) => Promise<Pick<ReminderTask, 'status'>>
export type TestReminder = (input: Pick<ReminderInput, 'channel' | 'text'>) => Promise<void>

export function isReminderAction(name: string): name is ReminderActionName {
  return Object.hasOwn(reminderActions, name)
}

// Verify each field after construction: Date otherwise advances Feb 30 and
// wall-clock times skipped during a daylight-saving transition.
export function parseLocalReminderTime(value: unknown): number {
  const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(value)
  if (!match) throw new Error('REMINDER_INVALID_TIME')
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day, hour, minute)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute) throw new Error('REMINDER_INVALID_TIME')
  return date.getTime()
}

// The device supplies the anchor and random seed exactly once, when building the approval card.
function requestedRecurrence(value: unknown, now: number) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>
    if (fields.frequency === 'interval') {
      if (Object.keys(fields).length !== 2 || typeof fields.minutes !== 'number') throw new Error('REMINDER_INVALID_TIME')
      return createIntervalRecurrence(fields.minutes, now)
    }
    if (fields.frequency === 'randomWindow') {
      if (Object.keys(fields).length !== 3 || typeof fields.startTime !== 'string' || typeof fields.endTime !== 'string') {
        throw new Error('REMINDER_INVALID_TIME')
      }
      return createRandomWindowRecurrence(fields.startTime, fields.endTime)
    }
  }
  return parseReminderRecurrence(value)
}

function reminderSchedule(args: Record<string, unknown>, requestedAt: number) {
  if (['atLocal', 'delaySeconds', 'recurrence'].filter(key => key in args).length !== 1) throw new Error('REMINDER_INVALID_TIME')
  if ('recurrence' in args) {
    const now = Date.now()
    const recurrence = requestedRecurrence(args.recurrence, now)
    return { at: nextReminderOccurrence(recurrence, now), recurrence }
  }
  if ('atLocal' in args) return { at: parseLocalReminderTime(args.atLocal) }
  const delay = args.delaySeconds
  if (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay < 1) throw new Error('REMINDER_INVALID_TIME')
  return { at: requestedAt + delay * 1000 }
}

function checkTime(at: number | undefined) {
  if (at !== undefined && (!Number.isFinite(new Date(at).getTime()) || at <= Date.now())) {
    throw new Error('REMINDER_INVALID_TIME')
  }
}

export function prepareReminderAction(name: ReminderActionName, args: Record<string, unknown>, requestedAt: number) {
  const { channel, scheduled } = reminderActions[name]
  const fields = scheduled ? ['text', 'delaySeconds', 'atLocal', 'recurrence'] : ['text', 'testOnly']
  if (Object.keys(args).some(key => !fields.includes(key)) || ('testOnly' in args && args.testOnly !== true)) {
    throw new Error('AI_INVALID_INPUT')
  }
  const testOnly = args.testOnly === true
  if ('text' in args && typeof args.text !== 'string') throw new Error('REMINDER_INVALID_TEXT')
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (Array.from(text).length > 300) throw new Error('REMINDER_INVALID_TEXT')
  const schedule = scheduled ? reminderSchedule(args, requestedAt) : undefined
  const at = schedule?.at
  checkTime(at)
  const time = at === undefined ? t(testOnly ? 'chat.reminder.testNow' : 'reminders.now') : new Intl.DateTimeFormat(locale.value, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(at)
  const rule = schedule?.recurrence && formatReminderRecurrence(schedule.recurrence)
  const lines = rule ? [rule, t('chat.reminder.next', { time })] : [time]
  if (schedule?.recurrence?.frequency === 'monthly' && schedule.recurrence.dayOfMonth > 28) lines.push(t('reminders.shortMonths'))
  lines.push(text || t('chat.reminder.petChooses'))
  return {
    name, lines,
    async apply(create: CreateReminder, test?: TestReminder) {
      if (testOnly) {
        if (!test) throw new Error('REMINDER_UNAVAILABLE')
        await test({ channel, text })
        return t(channel === 'popup' ? 'reminders.testedPopup' : 'reminders.testedNotification')
      }
      checkTime(at)
      const task = await create({ channel, text, ...schedule })
      if (task.status === 'completed') return t('chat.reminder.' + (channel === 'popup' ? 'shown' : 'sent'))
      if (task.status !== 'scheduled') throw new Error('REMINDER_STATE')
      if (rule) return t('chat.reminder.recurring', { channel: t('reminders.' + channel), rule, time })
      return at === undefined ? t('chat.reminder.queued')
        : t('chat.reminder.scheduled', { channel: t('reminders.' + channel), time })
    },
  }
}
