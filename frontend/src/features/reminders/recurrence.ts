/** A device-local wall-clock time (HH:mm), with ISO weekdays numbered Monday 1 to Sunday 7. */
export type ReminderRecurrence =
  | { frequency: 'daily'; time: string }
  | { frequency: 'weekly'; time: string; weekday: number }
  | { frequency: 'monthly'; time: string; dayOfMonth: number }

function invalid(): never {
  throw new Error('REMINDER_INVALID_TIME')
}

function isDay(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= limit
}

export function parseReminderRecurrence(value: unknown): ReminderRecurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const fields = value as Record<string, unknown>
  const { frequency, time } = fields
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return invalid()
  if (!Object.hasOwn(fields, 'frequency') || !Object.hasOwn(fields, 'time')) return invalid()
  const size = Object.keys(fields).length
  if (frequency === 'daily' && size === 2) return { frequency, time }
  if (frequency === 'weekly' && size === 3 && Object.hasOwn(fields, 'weekday') && isDay(fields.weekday, 7)) {
    return { frequency, time, weekday: fields.weekday }
  }
  if (frequency === 'monthly' && size === 3 && Object.hasOwn(fields, 'dayOfMonth') && isDay(fields.dayOfMonth, 31)) {
    return { frequency, time, dayOfMonth: fields.dayOfMonth }
  }
  return invalid()
}

function matchesDay(rule: ReminderRecurrence, day: Date): boolean {
  switch (rule.frequency) {
    case 'daily': return true
    case 'weekly': return (day.getUTCDay() || 7) === rule.weekday
    case 'monthly': return day.getUTCDate() === rule.dayOfMonth
  }
}

function findOccurrence(recurrence: ReminderRecurrence, reference: number, direction: 1 | -1): number {
  const rule = parseReminderRecurrence(recurrence)
  if (!Number.isSafeInteger(reference)) return invalid()
  const [hour, minute] = rule.time.split(':').map(Number)
  const local = new Date(reference)
  // Walk calendar dates in UTC so a time-zone jump that skips a whole day
  // cannot normalize a backwards step to the very same local date.
  const day = new Date(0)
  day.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate())
  while (Number.isFinite(day.getTime())) {
    if (matchesDay(rule, day)) {
      const year = day.getUTCFullYear()
      const month = day.getUTCMonth()
      const date = day.getUTCDate()
      const candidate = new Date(year, month, date, hour, minute)
      if (year >= 0 && year < 100) candidate.setFullYear(year, month, date)
      // Date selects the earlier instant in a fall-back overlap. In a spring-forward gap,
      // the requested wall time doesn't exist and Date normalizes it, so skip that day.
      const instant = candidate.getTime()
      if ((direction === 1 ? instant > reference : instant <= reference)
          && candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === date
          && candidate.getHours() === hour && candidate.getMinutes() === minute) return instant
    }
    day.setUTCDate(day.getUTCDate() + direction)
  }
  return invalid()
}

/** First matching instant strictly after the supplied time, even after a long absence. */
export function nextReminderOccurrence(rule: ReminderRecurrence, after: number): number {
  return findOccurrence(rule, after, 1)
}

/** Latest matching instant at or before the supplied time. */
export function previousReminderOccurrence(rule: ReminderRecurrence, at: number): number {
  return findOccurrence(rule, at, -1)
}
