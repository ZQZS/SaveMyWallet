package app.savemywallet.ledger

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class PetReminderRecurrenceTest {
    private val hongKong = TimeZone.getTimeZone("Asia/Hong_Kong")
    private val newYork = TimeZone.getTimeZone("America/New_York")
    private fun epoch(utc: String) = Instant.parse(utc).toEpochMilli()

    @Test fun monthlyRespectsShortMonthsAndTheCurrentDeviceZone() {
        val rule = PetReminderRecurrence("monthly", "09:00", dayOfMonth = 31)
        val after = epoch("2026-01-31T18:00:00Z")
        assertEquals(epoch("2026-03-31T01:00:00Z"), rule.nextAfter(after, hongKong))
        assertEquals(epoch("2026-03-31T13:00:00Z"), rule.nextAfter(after, newYork))
    }

    @Test fun missedWeeksAdvanceDirectlyToTheNextLocalWeekday() {
        val rule = PetReminderRecurrence("weekly", "08:15", weekday = 1)
        val after = epoch("2026-11-22T08:00:00Z")
        assertEquals(20261116, rule.lastDueDay(after, hongKong))
        assertEquals(epoch("2026-11-23T00:15:00Z"), rule.nextAfter(after, hongKong, 20260921))
    }

    @Test fun skipsMissingHoursAndFiresOnlyAtTheEarlierOccurrenceDuringTheFold() {
        val spring = PetReminderRecurrence("daily", "02:30")
        assertEquals(epoch("2026-03-09T06:30:00Z"), spring.nextAfter(epoch("2026-03-07T08:00:00Z"), newYork))
        val autumn = PetReminderRecurrence("daily", "01:30")
        val first = epoch("2026-11-01T05:30:00Z")
        assertEquals(first, autumn.nextAfter(epoch("2026-10-31T07:00:00Z"), newYork))
        assertEquals(epoch("2026-11-02T06:30:00Z"), autumn.nextAfter(first, newYork))
    }

    @Test fun clockOrZoneChangesDoNotReplayAnAlreadyDeliveredLocalDay() {
        val rule = PetReminderRecurrence("daily", "09:00")
        val after = epoch("2026-11-21T01:00:00Z")
        assertEquals(epoch("2026-11-23T14:00:00Z"), rule.nextAfter(after, newYork, 20261122))
    }

    @Test fun morningCatchUpKeepsTodaysOccurrenceIfItsClockTimeHasNotPassed() {
        val rule = PetReminderRecurrence("daily", "09:00")
        val before = epoch("2026-11-22T00:30:00Z")
        assertEquals(20261121, rule.lastDueDay(before, hongKong))
        assertEquals(epoch("2026-11-22T01:00:00Z"), rule.nextAfter(before, hongKong, 20261121))
        val after = epoch("2026-11-22T02:00:00Z")
        val latest = rule.lastDueDay(after, hongKong)
        assertEquals(20261122, latest)
        assertEquals(epoch("2026-11-23T14:00:00Z"), rule.nextAfter(after, newYork, latest))
    }
}
