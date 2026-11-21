import { locale, t } from '../../i18n/index.ts'
import type { ReminderRecurrence } from './recurrence.ts'

export function formatReminderRecurrence(rule: ReminderRecurrence): string {
  if (rule.frequency === 'weekly') {
    // 2024-01-01 was a Monday, ISO weekday 1.
    const weekday = new Intl.DateTimeFormat(locale.value, {
      weekday: locale.value === 'zh-CN' ? 'short' : 'long', timeZone: 'UTC',
    }).format(Date.UTC(2024, 0, rule.weekday))
    return t('reminderRule.weekly', { weekday, time: rule.time })
  }
  if (rule.frequency === 'monthly') return t('reminderRule.monthly', { day: rule.dayOfMonth, time: rule.time })
  return t('reminderRule.daily', { time: rule.time })
}
