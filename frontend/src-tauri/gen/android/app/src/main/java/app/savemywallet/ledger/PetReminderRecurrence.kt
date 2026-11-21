package app.savemywallet.ledger

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

internal data class PetReminderRecurrence(
    val frequency: String,
    val time: String,
    val weekday: Int? = null,
    val dayOfMonth: Int? = null,
) {
    init {
        require(time.matches(Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]")))
        require(when (frequency) {
            "daily" -> weekday == null && dayOfMonth == null
            "weekly" -> weekday != null && weekday in 1..7 && dayOfMonth == null
            "monthly" -> dayOfMonth != null && dayOfMonth in 1..31 && weekday == null
            else -> false
        })
    }

    // Use civil days, including on Android 7 where java.time is unavailable.
    // A month without the requested date and a missing DST wall time have no occurrence.
    fun nextAfter(after: Long, zone: TimeZone, lastLocalDay: Int = 0) = occurrence(after, zone, lastLocalDay, forward = true)

    fun lastDueDay(now: Long, zone: TimeZone): Int = localDay(occurrence(now, zone, 0, forward = false), zone)

    private fun occurrence(boundary: Long, zone: TimeZone, lastLocalDay: Int, forward: Boolean): Long {
        val local = GregorianCalendar(zone, Locale.ROOT).apply { timeInMillis = boundary }
        val hour = time.substring(0, 2).toInt()
        val minute = time.substring(3).toInt()
        val day = GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT).apply {
            clear()
            if (localDay(local) < lastLocalDay) {
                set(lastLocalDay / 10000, lastLocalDay / 100 % 100 - 1, lastLocalDay % 100)
            } else {
                set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH))
            }
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
        }
        while (true) {
            val matches = when (frequency) {
                "weekly" -> (day.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1 == weekday
                "monthly" -> day.get(Calendar.DAY_OF_MONTH) == dayOfMonth
                else -> true
            }
            if (matches && localDay(day) > lastLocalDay) {
                val wall = day.timeInMillis
                // Try the offsets on either side of this local date. Two valid offsets
                // mean an autumn fold: only its earlier instant represents this occurrence.
                val offsets = listOf(zone.getOffset(wall - 86400000L), zone.getOffset(wall + 86400000L))
                val instant = offsets.distinct().map { wall - it }
                    .filter { it + zone.getOffset(it) == wall }.minOrNull()
                if (instant != null && (if (forward) instant > boundary else instant <= boundary)) return instant
            }
            day.add(Calendar.DAY_OF_MONTH, if (forward) 1 else -1)
        }
    }

    companion object {
        private fun localDay(day: Calendar): Int = day.get(Calendar.YEAR) * 10000 +
            (day.get(Calendar.MONTH) + 1) * 100 + day.get(Calendar.DAY_OF_MONTH)

        fun localDay(instant: Long, zone: TimeZone): Int =
            localDay(GregorianCalendar(zone, Locale.ROOT).apply { timeInMillis = instant })
    }
}
