/** Device-local clock times use HH:mm and ISO weekdays run from Monday 1 to Sunday 7. */
type CalendarRecurrence =
  | { frequency: 'daily'; time: string }
  | { frequency: 'weekly'; time: string; weekday: number }
  | { frequency: 'monthly'; time: string; dayOfMonth: number }

type IntervalRecurrence = { frequency: 'interval'; minutes: number; anchorAt: number }
type RandomWindowRecurrence = { frequency: 'randomWindow'; startTime: string; endTime: string; seed: number }
export type ReminderRecurrence = CalendarRecurrence | IntervalRecurrence | RandomWindowRecurrence

const MINUTE = 60_000
const DAY = 1440
export const MAX_INTERVAL_MINUTES = 31 * DAY

function invalid(): never {
  throw new Error('REMINDER_INVALID_TIME')
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function validInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
}

function clock(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function minutesOfDay(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))
}

function intervalRule(minutes: unknown, anchorAt: unknown): IntervalRecurrence {
  if (!integer(minutes, 10, MAX_INTERVAL_MINUTES) || minutes % 10 !== 0
      || !validInstant(anchorAt) || anchorAt <= 0 || anchorAt % 1000 !== 0) return invalid()
  return { frequency: 'interval', minutes, anchorAt }
}

export function createIntervalRecurrence(minutes: number, now: number): IntervalRecurrence {
  if (!validInstant(now)) return invalid()
  return intervalRule(minutes, Math.ceil(now / 1000) * 1000 + minutes * MINUTE)
}

function randomRule(startTime: unknown, endTime: unknown, seed: unknown): RandomWindowRecurrence {
  if (!clock(startTime) || !clock(endTime) || startTime === endTime || !integer(seed, 0, 0x7fffffff)) return invalid()
  return { frequency: 'randomWindow', startTime, endTime, seed }
}

export function createRandomWindowRecurrence(startTime: string, endTime: string, seed?: number): RandomWindowRecurrence {
  const perTaskSeed = seed === undefined ? crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff : seed
  return randomRule(startTime, endTime, perTaskSeed)
}

export function parseReminderRecurrence(value: unknown): ReminderRecurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const fields = value as Record<string, unknown>
  function hasOnly(...keys: string[]) {
    return Object.keys(fields).length === keys.length && keys.every(key => Object.hasOwn(fields, key))
  }
  const { frequency, time } = fields
  if (frequency === 'interval' && hasOnly('frequency', 'minutes', 'anchorAt')) return intervalRule(fields.minutes, fields.anchorAt)
  if (frequency === 'randomWindow' && hasOnly('frequency', 'startTime', 'endTime', 'seed')) {
    return randomRule(fields.startTime, fields.endTime, fields.seed)
  }
  if (!clock(time)) return invalid()
  if (frequency === 'daily' && hasOnly('frequency', 'time')) return { frequency, time }
  if (frequency === 'weekly' && hasOnly('frequency', 'time', 'weekday') && integer(fields.weekday, 1, 7)) {
    return { frequency, time, weekday: fields.weekday }
  }
  if (frequency === 'monthly' && hasOnly('frequency', 'time', 'dayOfMonth') && integer(fields.dayOfMonth, 1, 31)) {
    return { frequency, time, dayOfMonth: fields.dayOfMonth }
  }
  return invalid()
}

// Use UTC for arithmetic on civil dates, including when a zone skips a whole local day.
function civilDay(local: Date): Date {
  const day = new Date(0)
  day.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate())
  return day
}

function changeDay(day: Date, delta: number) {
  day.setUTCDate(day.getUTCDate() + delta)
}

function dayNumber(day: Date) {
  return day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate()
}

// The same 32-bit mix is used in the Windows helper and Android broadcast receiver.
// An occurrence can be reconstructed from the saved task seed and the window's starting date.
function windowMinute(rule: RandomWindowRecurrence, day: Date) {
  const start = minutesOfDay(rule.startTime)
  const span = (minutesOfDay(rule.endTime) - start + DAY) % DAY
  let hash = (rule.seed ^ dayNumber(day)) >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
  return start + ((hash ^ (hash >>> 16)) >>> 0) % (span + 1)
}

function wallInstant(day: Date, minutes: number): number {
  const wall = new Date(day.getTime() + minutes * MINUTE)
  const year = wall.getUTCFullYear(), month = wall.getUTCMonth(), date = wall.getUTCDate()
  const hour = wall.getUTCHours(), minute = wall.getUTCMinutes()
  const candidate = new Date(year, month, date, hour, minute)
  if (year >= 0 && year < 100) candidate.setFullYear(year, month, date)
  // Date chooses the earlier occurrence in a fold. Reject normalization through a gap.
  return candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === date
    && candidate.getHours() === hour && candidate.getMinutes() === minute ? candidate.getTime() : NaN
}

function findOccurrence(recurrence: ReminderRecurrence, reference: number, direction: 1 | -1): number {
  const rule = parseReminderRecurrence(recurrence)
  if (!validInstant(reference)) return invalid()
  if (rule.frequency === 'interval') {
    const period = rule.minutes * MINUTE
    const index = Math.floor((reference - rule.anchorAt) / period)
    if (direction === -1 && index < 0) return invalid()
    const at = rule.anchorAt + Math.max(0, direction === 1 ? index + 1 : index) * period
    return validInstant(at) ? at : invalid()
  }
  const day = civilDay(new Date(reference))
  // A window that started yesterday can have its randomly selected minute today.
  if (direction === 1 && rule.frequency === 'randomWindow' && rule.startTime > rule.endTime) changeDay(day, -1)
  while (Number.isFinite(day.getTime())) {
    if ((rule.frequency !== 'weekly' || (day.getUTCDay() || 7) === rule.weekday)
        && (rule.frequency !== 'monthly' || day.getUTCDate() === rule.dayOfMonth)) {
      const minutes = rule.frequency === 'randomWindow' ? windowMinute(rule, day) : minutesOfDay(rule.time)
      const instant = wallInstant(day, minutes)
      if (direction === 1 ? instant > reference : instant <= reference) return instant
    }
    changeDay(day, direction)
  }
  return invalid()
}

/** First matching instant strictly after the supplied time, even after a long absence. */
export function nextReminderOccurrence(rule: ReminderRecurrence, after: number): number {
  return findOccurrence(rule, after, 1)
}

/** Latest matching instant at or before the supplied time. An interval has none before its anchor. */
export function previousReminderOccurrence(rule: ReminderRecurrence, at: number): number {
  return findOccurrence(rule, at, -1)
}

function windowStartDay(rule: RandomWindowRecurrence, at: number): Date | undefined {
  const local = new Date(at)
  const minute = local.getHours() * 60 + local.getMinutes()
  const start = minutesOfDay(rule.startTime), end = minutesOfDay(rule.endTime)
  const day = civilDay(local)
  if (start < end) return minute >= start && minute <= end ? day : undefined
  if (minute >= start) return day
  if (minute > end) return undefined
  changeDay(day, -1)
  return day
}

// Use the starting date for windows spanning midnight; consecutive windows can select
// two occurrences on the same calendar date. Elapsed intervals have no local date key.
export function reminderOccurrenceDay(rule: ReminderRecurrence, occurrence: number): string | undefined {
  if (rule.frequency === 'interval') return undefined
  const day = rule.frequency === 'randomWindow' ? windowStartDay(rule, occurrence) : civilDay(new Date(occurrence))
  return day?.toISOString().split('T')[0]
}

export function inReminderWindow(rule: RandomWindowRecurrence, occurrence: number, now: number): boolean {
  const start = windowStartDay(rule, now)
  return !!start && start.getTime() === windowStartDay(rule, occurrence)?.getTime()
}

/** First instant outside the open window. Its end minute, including its seconds, is still inside. */
export function reminderWindowExpiresAt(rule: RandomWindowRecurrence, occurrence: number, now: number): number {
  if (!inReminderWindow(rule, occurrence, now)) return now
  const local = new Date(now)
  const remainingMinutes = (minutesOfDay(rule.endTime) - (local.getHours() * 60 + local.getMinutes()) + DAY) % DAY
  const nextMinute = Math.floor(now / MINUTE) * MINUTE + MINUTE
  const nominalEnd = nextMinute + remainingMinutes * MINUTE
  if (local.getTimezoneOffset() === new Date(nominalEnd).getTimezoneOffset()) return nominalEnd

  // Across a clock jump, the nominal end may be missing or occur twice. Find the first
  // minute outside this specific window up front so the UI needs only one expiry timer.
  for (let at = nextMinute; ; at += MINUTE) {
    if (!inReminderWindow(rule, occurrence, at)) return at
  }
}
