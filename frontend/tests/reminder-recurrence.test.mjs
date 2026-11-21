import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { nextReminderOccurrence, parseReminderRecurrence, previousReminderOccurrence } from '../src/features/reminders/recurrence.ts'

const oldZone = process.env.TZ
process.env.TZ = 'America/New_York'
after(() => {
  if (oldZone === undefined) delete process.env.TZ
  else process.env.TZ = oldZone
})

function next(rule, after, expected) {
  assert.equal(nextReminderOccurrence(rule, Date.parse(after)), Date.parse(expected))
}

function previous(rule, at, expected) {
  assert.equal(previousReminderOccurrence(rule, Date.parse(at)), Date.parse(expected))
}

test('previous occurrence is inclusive and skips months without the day', () => {
  const monthly = { frequency: 'monthly', dayOfMonth: 31, time: '09:00' }
  previous(monthly, '2028-03-31T09:00:00', '2028-03-31T09:00:00')
  previous(monthly, '2028-03-31T08:59:59.999', '2028-01-31T09:00:00')
  previous(monthly, '2028-01-01T01:00', '2027-12-31T09:00')
  const sunday = { frequency: 'weekly', weekday: 7, time: '09:00' }
  previous(sunday, '2026-11-22T08:30', '2026-11-15T09:00')
})

test('daily and weekly schedules use local dates and advance past an exact match', () => {
  const daily = { frequency: 'daily', time: '09:00' }
  next(daily, '2026-12-31T08:59:59.999', '2026-12-31T09:00')
  next(daily, '2026-12-31T09:00', '2027-01-01T09:00')
  const sunday = { frequency: 'weekly', weekday: 7, time: '09:00' }
  next(sunday, '2026-11-22T08:59', '2026-11-22T09:00')
  next(sunday, '2026-11-22T09:01', '2026-11-29T09:00')
  next({ frequency: 'weekly', weekday: 1, time: '00:00' }, '2026-11-22T23:59', '2026-11-23T00:00')
})

test('monthly rules skip missing dates, including across leap years', () => {
  const last = { frequency: 'monthly', dayOfMonth: 31, time: '09:00' }
  next(last, '2026-01-31T09:00', '2026-03-31T09:00')
  next(last, '2026-04-01T00:00', '2026-05-31T09:00')
  const leap = { ...last, dayOfMonth: 29 }
  next(leap, '2028-02-01T00:00', '2028-02-29T09:00')
  next(leap, '2027-02-01T00:00', '2027-03-29T09:00')
  next({ ...last, dayOfMonth: 10 }, '2026-11-22T00:00', '2026-12-10T09:00')
})

test('advance directly beyond the current time after a long absence', () => {
  const rule = { frequency: 'monthly', dayOfMonth: 10, time: '09:00' }
  const original = nextReminderOccurrence(rule, Date.parse('2020-01-01T09:00'))
  assert.equal(original, Date.parse('2020-01-10T09:00'))
  const reopenedAt = Date.parse('2026-12-10T14:00')
  assert.equal(nextReminderOccurrence(rule, reopenedAt), Date.parse('2027-01-10T09:00'))
})

test('spring gap skips the missing clock time and fall overlap fires only at the earlier instant', () => {
  const daily = { frequency: 'daily', time: '02:30' }
  next(daily, '2026-03-07T02:30:00-05:00', '2026-03-09T02:30:00-04:00')
  // New York changes from 01:59 EST to 03:00 EDT on March 8.
  const weekly = { frequency: 'weekly', weekday: 7, time: '02:30' }
  next(weekly, '2026-03-08T01:30:00-05:00', '2026-03-15T02:30:00-04:00')
  const monthly = { frequency: 'monthly', dayOfMonth: 8, time: '02:30' }
  next(monthly, '2026-03-08T01:00:00-05:00', '2026-04-08T02:30:00-04:00')
  const overlap = { frequency: 'daily', time: '01:30' }
  next(overlap, '2026-11-01T01:00:00-04:00', '2026-11-01T01:30:00-04:00')
  next(overlap, '2026-11-01T01:00:00-05:00', '2026-11-02T01:30:00-05:00')
  previous(daily, '2026-03-08T03:00:00-04:00', '2026-03-07T02:30:00-05:00')
  previous(overlap, '2026-11-01T01:01:00-05:00', '2026-11-01T01:30:00-04:00')
})

test('the same saved rule follows the device local clock after a time-zone change', () => {
  const rule = { frequency: 'monthly', dayOfMonth: 10, time: '09:00' }
  const after = '2026-12-01T00:00:00Z'
  next(rule, after, '2026-12-10T14:00:00Z')
  try {
    process.env.TZ = 'Asia/Hong_Kong'
    next(rule, after, '2026-12-10T01:00:00Z')
    process.env.TZ = 'Pacific/Apia'
    // Samoa skipped the entire local date of 2011-12-30.
    next({ ...rule, dayOfMonth: 30 }, '2011-12-20T09:00', '2012-01-30T09:00')
    previous({ ...rule, dayOfMonth: 30 }, '2011-12-31T10:00', '2011-11-30T09:00')
  } finally {
    process.env.TZ = 'America/New_York'
  }
})

test('rejects invalid stored or proposed recurrence fields and out-of-range instants', () => {
  const daily = { frequency: 'daily', time: '09:00' }
  assert.deepEqual(parseReminderRecurrence(daily), daily)
  for (const value of [null, [], {}, { ...daily, time: '24:00' }, { ...daily, time: '9:00' },
    { ...daily, time: '09:60' }, { ...daily, frequency: 'yearly' }, { ...daily, weekday: 1 },
    { ...daily, frequency: 'weekly' }, { ...daily, frequency: 'weekly', weekday: 0 },
    { ...daily, frequency: 'weekly', weekday: '3' }, { ...daily, frequency: 'monthly', dayOfMonth: 32 },
    { ...daily, frequency: 'monthly', dayOfMonth: 1.5 }]) {
    assert.throws(() => parseReminderRecurrence(value), /REMINDER_INVALID_TIME/)
  }
  for (const invalidTime of [NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => nextReminderOccurrence(daily, invalidTime), /REMINDER_INVALID_TIME/)
  }
})
