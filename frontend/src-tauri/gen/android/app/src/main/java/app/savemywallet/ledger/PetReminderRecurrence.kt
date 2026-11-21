package app.savemywallet.ledger

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

internal sealed class PetReminderRecurrence {
    data class Advance(val nextAt: Long, val lastLocalDay: Int, val notify: Boolean)

    abstract fun nextAfter(after: Long, zone: TimeZone, lastLocalDay: Int = 0): Long
    abstract fun advanceDue(now: Long, zone: TimeZone): Advance

    data class Interval(val minutes: Int, val anchorAt: Long) : PetReminderRecurrence() {
        init {
            require(minutes in 10..44_640 && minutes % 10 == 0)
            require(anchorAt in 1..8_640_000_000_000_000L && anchorAt % 1000 == 0L)
        }
        private val period = minutes * 60_000L

        override fun nextAfter(after: Long, zone: TimeZone, lastLocalDay: Int): Long {
            if (after < anchorAt) return anchorAt
            return after + period - (after - anchorAt) % period
        }

        override fun advanceDue(now: Long, zone: TimeZone) = Advance(nextAfter(now, zone), 0, true)
    }

    // Calendar rules operate on nominal local dates and choose the earlier instant during a fold.
    // Use Calendar so the receiver works on Android 7, where java.time is unavailable.
    sealed class Civil : PetReminderRecurrence() {
        data class Slot(val instant: Long, val startDay: Int)

        protected open val overnight = false
        protected abstract fun minuteFor(day: Calendar): Int?
        protected open fun canNotify(now: Long, zone: TimeZone, slot: Slot) = true

        final override fun nextAfter(after: Long, zone: TimeZone, lastLocalDay: Int) =
            occurrence(after, zone, lastLocalDay, forward = true).instant

        fun lastDueDay(now: Long, zone: TimeZone) = occurrence(now, zone, 0, forward = false).startDay

        final override fun advanceDue(now: Long, zone: TimeZone): Advance {
            val latest = occurrence(now, zone, 0, forward = false)
            return Advance(nextAfter(now, zone, latest.startDay), latest.startDay, canNotify(now, zone, latest))
        }

        private fun occurrence(boundary: Long, zone: TimeZone, lastDay: Int, forward: Boolean): Slot {
            val day = civilDay(local(boundary, zone))
            if (overnight && forward) day.add(Calendar.DAY_OF_MONTH, -1)
            if (forward && dayKey(day) <= lastDay) {
                day.set(lastDay / 10000, lastDay / 100 % 100 - 1, lastDay % 100)
                day.add(Calendar.DAY_OF_MONTH, 1)
            }
            while (true) {
                val minutes = minuteFor(day)
                if (minutes != null) {
                    val instant = resolveWall(day.timeInMillis + minutes * 60_000L, zone)
                    if (instant != null && (if (forward) instant > boundary else instant <= boundary))
                        return Slot(instant, dayKey(day))
                }
                day.add(Calendar.DAY_OF_MONTH, if (forward) 1 else -1)
            }
        }
    }

    data class CalendarRule(val frequency: String, val time: String, val weekday: Int? = null,
                            val dayOfMonth: Int? = null) : Civil() {
        private val minute = clockMinute(time)
        init {
            require(when (frequency) {
                "daily" -> weekday == null && dayOfMonth == null
                "weekly" -> weekday != null && weekday in 1..7 && dayOfMonth == null
                "monthly" -> dayOfMonth != null && dayOfMonth in 1..31 && weekday == null
                else -> false
            })
        }

        override fun minuteFor(day: Calendar): Int? = when {
            frequency == "weekly" && (day.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1 != weekday -> null
            frequency == "monthly" && day.get(Calendar.DAY_OF_MONTH) != dayOfMonth -> null
            else -> minute
        }
    }

    data class RandomWindow(val startTime: String, val endTime: String, val seed: Int) : Civil() {
        private val start = clockMinute(startTime)
        private val end = clockMinute(endTime)
        override val overnight = end < start
        private val span = (end - start + 1440) % 1440

        init { require(start != end && seed >= 0) }

        override fun minuteFor(day: Calendar): Int {
            // The web and Windows schedulers use the same 32-bit mix and the window's start date.
            var x = seed xor dayKey(day)
            x = (x xor (x ushr 16)) * 0x45d9f3b
            x = (x xor (x ushr 16)) * 0x45d9f3b
            val offset = (x xor (x ushr 16)).toUInt() % (span + 1).toUInt()
            return start + offset.toInt()
        }

        override fun canNotify(now: Long, zone: TimeZone, slot: Slot): Boolean {
            val here = local(now, zone)
            val minute = here.get(Calendar.HOUR_OF_DAY) * 60 + here.get(Calendar.MINUTE)
            if ((minute - start + 1440) % 1440 > span) return false
            val startDay = civilDay(here)
            if (overnight && minute < start) startDay.add(Calendar.DAY_OF_MONTH, -1)
            return dayKey(startDay) == slot.startDay
        }
    }

    companion object {
        private val clockFormat = Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")
        private fun clockMinute(time: String): Int {
            require(clockFormat.matches(time))
            return time.substring(0, 2).toInt() * 60 + time.substring(3).toInt()
        }

        private fun dayKey(day: Calendar) = day.get(Calendar.YEAR) * 10000 +
            (day.get(Calendar.MONTH) + 1) * 100 + day.get(Calendar.DAY_OF_MONTH)

        private fun local(instant: Long, zone: TimeZone) = GregorianCalendar(zone, Locale.ROOT).apply {
            timeInMillis = instant
        }

        private fun civilDay(local: Calendar) = GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT).apply {
            clear()
            set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH))
        }

        private fun resolveWall(wall: Long, zone: TimeZone): Long? {
            val offsets = listOf(zone.getOffset(wall - 86_400_000L), zone.getOffset(wall + 86_400_000L))
            return offsets.distinct().map { wall - it }
                .filter { it + zone.getOffset(it) == wall }.minOrNull()
        }
    }
}
