package app.savemywallet.ledger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class PetReminderRecurrenceTest {
    private val hongKong = TimeZone.getTimeZone("Asia/Hong_Kong")
    private val newYork = TimeZone.getTimeZone("America/New_York")
    private fun epoch(utc: String) = Instant.parse(utc).toEpochMilli()

    @Test fun monthlyRespectsShortMonthsAndTheCurrentDeviceZone() {
        val rule = PetReminderRecurrence.CalendarRule("monthly", "09:00", dayOfMonth = 31)
        val after = epoch("2026-01-31T18:00:00Z")
        assertEquals(epoch("2026-03-31T01:00:00Z"), rule.nextAfter(after, hongKong))
        assertEquals(epoch("2026-03-31T13:00:00Z"), rule.nextAfter(after, newYork))
    }

    @Test fun missedWeeksAdvanceDirectlyToTheNextLocalWeekday() {
        val rule = PetReminderRecurrence.CalendarRule("weekly", "08:15", weekday = 1)
        val after = epoch("2026-11-22T08:00:00Z")
        assertEquals(20261116, rule.lastDueDay(after, hongKong))
        assertEquals(epoch("2026-11-23T00:15:00Z"), rule.nextAfter(after, hongKong, 20260921))
    }

    @Test fun skipsMissingHoursAndFiresOnlyAtTheEarlierOccurrenceDuringTheFold() {
        val spring = PetReminderRecurrence.CalendarRule("daily", "02:30")
        assertEquals(epoch("2026-03-09T06:30:00Z"), spring.nextAfter(epoch("2026-03-07T08:00:00Z"), newYork))
        val autumn = PetReminderRecurrence.CalendarRule("daily", "01:30")
        val first = epoch("2026-11-01T05:30:00Z")
        assertEquals(first, autumn.nextAfter(epoch("2026-10-31T07:00:00Z"), newYork))
        assertEquals(epoch("2026-11-02T06:30:00Z"), autumn.nextAfter(first, newYork))
    }

    @Test fun clockOrZoneChangesDoNotReplayAnAlreadyDeliveredLocalDay() {
        val rule = PetReminderRecurrence.CalendarRule("daily", "09:00")
        val after = epoch("2026-11-21T01:00:00Z")
        assertEquals(epoch("2026-11-23T14:00:00Z"), rule.nextAfter(after, newYork, 20261122))
    }

    @Test fun morningCatchUpKeepsTodaysOccurrenceIfItsClockTimeHasNotPassed() {
        val rule = PetReminderRecurrence.CalendarRule("daily", "09:00")
        val before = epoch("2026-11-22T00:30:00Z")
        assertEquals(20261121, rule.lastDueDay(before, hongKong))
        assertEquals(epoch("2026-11-22T01:00:00Z"), rule.nextAfter(before, hongKong, 20261121))
        val after = epoch("2026-11-22T02:00:00Z")
        val latest = rule.lastDueDay(after, hongKong)
        assertEquals(20261122, latest)
        assertEquals(epoch("2026-11-23T14:00:00Z"), rule.nextAfter(after, newYork, latest))
    }

    @Test fun intervalSurvivesDozeAndZoneChangesWithoutLosingItsPhase() {
        val first = epoch("2026-11-22T04:17:31Z")
        val rule = PetReminderRecurrence.Interval(20, first)
        assertEquals(first, rule.nextAfter(first - 1, hongKong))
        assertEquals(first + 1_200_000, rule.nextAfter(first, newYork))
        val wake = epoch("2026-11-25T13:16:08Z")
        val next = epoch("2026-11-25T13:17:31Z")
        assertEquals(PetReminderRecurrence.Advance(next, 0, true), rule.advanceDue(wake, hongKong))
        assertEquals(next, rule.nextAfter(wake, newYork))
        val longest = PetReminderRecurrence.Interval(44_640, first)
        assertEquals(first + 31L * 86_400_000, longest.nextAfter(first, hongKong))
    }

    @Test fun lunchUsesTheSharedSeedVectorAndSkipsMissedWindows() {
        val lunch = PetReminderRecurrence.RandomWindow("11:30", "13:00", 42)
        val nov22 = epoch("2026-11-22T03:56:00Z")
        val nov23 = epoch("2026-11-23T03:59:00Z")
        assertEquals(nov22, lunch.nextAfter(nov22 - 1, hongKong))
        assertEquals(nov23, lunch.nextAfter(nov22, hongKong))
        assertEquals(PetReminderRecurrence.Advance(nov23, 20261122, true),
            lunch.advanceDue(epoch("2026-11-22T05:00:59.999Z"), hongKong))
        assertFalse(lunch.advanceDue(epoch("2026-11-22T05:01:00Z"), hongKong).notify)
        // Already inside the next day's window, but its own random minute hasn't arrived yet.
        val morning = lunch.advanceDue(epoch("2026-11-23T03:45:00Z"), hongKong)
        assertFalse(morning.notify)
        assertEquals(nov23, morning.nextAt)
        assertTrue(lunch.advanceDue(nov23, hongKong).notify)
    }

    @Test fun aWindowSpanningMidnightBelongsToItsStartDay() {
        val night = PetReminderRecurrence.RandomWindow("23:00", "01:00", 42)
        val first = epoch("2026-11-22T15:55:00Z")
        val second = epoch("2026-11-23T16:44:00Z") // Nov 24 local
        assertEquals(second, night.nextAfter(first, hongKong))
        assertEquals(second, night.nextAfter(second - 1, hongKong))
        val caughtUp = night.advanceDue(epoch("2026-11-23T16:55:00Z"), hongKong)
        assertTrue(caughtUp.notify)
        assertEquals(20261123, caughtUp.lastLocalDay)
        assertFalse(night.advanceDue(epoch("2026-11-23T18:00:00Z"), hongKong).notify)
        // A westward time zone change must not post twice for the same window.
        assertEquals(night.nextAfter(second, newYork, 20261123),
            night.nextAfter(epoch("2026-11-24T06:01:00Z"), newYork))
    }

    @Test fun sampledNonexistentTimeIsSkippedAndAnOverlapUsesItsEarlierInstant() {
        val gap = PetReminderRecurrence.RandomWindow("02:00", "02:59", 42)
        val next = gap.nextAfter(epoch("2026-03-07T08:00:00Z"), newYork)
        assertTrue(next in epoch("2026-03-09T06:00:00Z")..epoch("2026-03-09T06:59:00Z"))
        val fold = PetReminderRecurrence.RandomWindow("01:00", "01:59", 42)
        val first = epoch("2026-11-01T05:50:00Z")
        assertEquals(first, fold.nextAfter(epoch("2026-10-31T07:00:00Z"), newYork))
        assertTrue(fold.nextAfter(first, newYork) >= epoch("2026-11-02T06:00:00Z"))
    }

    @Test fun invalidRulesNeverRegisterAnAlarm() {
        for (minutes in listOf(0, 9, 11, 44650)) {
            assertThrows(IllegalArgumentException::class.java) { PetReminderRecurrence.Interval(minutes, 1000) }
        }
        for (anchorAt in listOf(-1000L, 0L, 999L)) {
            assertThrows(IllegalArgumentException::class.java) { PetReminderRecurrence.Interval(10, anchorAt) }
        }
        for (end in listOf("12:00", "24:00", "12:60", "1:00")) {
            assertThrows(IllegalArgumentException::class.java) { PetReminderRecurrence.RandomWindow("12:00", end, 0) }
        }
        assertThrows(IllegalArgumentException::class.java) { PetReminderRecurrence.RandomWindow("10:00", "12:00", -1) }
    }
}
