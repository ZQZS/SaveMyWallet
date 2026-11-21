import { locale, t } from '../../i18n/index.ts'
import { formatReminderRecurrence } from './recurrenceFormat.ts'
import type { ReminderTask } from './reminderService.ts'

export interface ReminderManagement {
  list(): Promise<ReminderTask[]>
  setEnabled(id: number, enabled: boolean, revision: number): Promise<void>
  remove(id: number, revision: number): Promise<void>
}

export async function prepareReminderManagement(
  args: Record<string, unknown>, question: string, management: ReminderManagement,
) {
  const { operation, taskId, subject } = args
  if ((operation !== 'enable' && operation !== 'disable' && operation !== 'delete') ||
      Object.keys(args).some(key => !['operation', 'taskId', 'subject'].includes(key)) ||
      Object.hasOwn(args, 'taskId') === Object.hasOwn(args, 'subject')) throw new Error('AI_INVALID_INPUT')

  const title = typeof subject === 'string' ? subject.trim() : ''
  if (Object.hasOwn(args, 'taskId')) {
    if (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId < 1 || taskId > 0x7fffffff) {
      throw new Error('AI_INVALID_INPUT')
    }
    // Distinguish an explicit alarm ID from a time, amount or number of minutes.
    const idMention = new RegExp('(?:#\\s*|编号\\s*[:：]?\\s*|\\b(?:id|number|no\\.?)\\s*[:：]?\\s*)' + taskId + '(?![0-9])', 'i')
    if (!idMention.test(question.normalize('NFKC'))) throw new Error('REMINDER_TARGET_REQUIRED')
  } else if (!title || Array.from(title).length > 300 || !question.includes(title)) {
    throw new Error('REMINDER_TARGET_REQUIRED')
  }

  async function target() {
    const plans = (await management.list()).filter(item => item.scheduled)
    const matches = plans.filter(item => taskId === undefined ? item.text === title : item.id === taskId)
    if (matches.length === 0) throw new Error('REMINDER_TARGET_MISSING')
    if (matches.length !== 1 || (title && plans.some(item =>
      item.text !== title && item.text.includes(title) && question.includes(item.text)))) {
      throw new Error('REMINDER_TARGET_AMBIGUOUS')
    }
    return matches[0]
  }

  const task = await target()
  const enabled = task.status === 'scheduled'
  if (!enabled && !['disabled', 'cancelled', 'completed', 'failed'].includes(task.status)) {
    throw new Error('REMINDER_STATE')
  }
  if (operation === 'enable' && !enabled && !task.recurrence && task.at <= Date.now()) throw new Error('REMINDER_EXPIRED')
  const unchanged = (operation === 'enable' && enabled) || (operation === 'disable' && !enabled)
  const when = task.recurrence ? formatReminderRecurrence(task.recurrence)
    : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(task.at)
  const lines = [t('chat.reminder.manage.' + operation), '#' + task.id + ' · ' + (task.text || task.message),
    t('reminders.' + task.channel) + ' · ' + task.petName, when]
  return {
    name: 'manage_reminder' as const, lines, unchanged,
    message: t(unchanged ? 'chat.reminder.sameState' : 'chat.reminder.managed.' + operation),
    async apply(signal: AbortSignal) {
      const fresh = await target()
      if (fresh.id !== task.id || fresh.revision !== task.revision || fresh.status !== task.status || fresh.at !== task.at) {
        throw new Error('REMINDER_STATE')
      }
      if (signal.aborted) return false
      if (operation === 'delete') await management.remove(task.id, task.revision ?? 0)
      else await management.setEnabled(task.id, operation === 'enable', task.revision ?? 0)
      return true
    },
  }
}
