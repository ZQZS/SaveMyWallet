package app.savemywallet.ledger

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.TimeZone
import java.util.concurrent.Executors

class PetReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        PetReminders.worker.execute {
            try {
                when (intent.action) {
                    Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
                    Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> PetReminders.restore(context)
                    PetReminders.ALARM -> if (intent.hasExtra("id")) {
                        PetReminders.deliver(context, intent.getIntExtra("id", 0))
                    }
                }
            } catch (failure: Exception) {
                PetReminders.logFailure(failure)
            } finally {
                pending.finish()
            }
        }
    }
}

internal object PetReminders {
    // Broadcasts and bridge calls can arrive simultaneously, including after activity recreation.
    val worker = Executors.newSingleThreadExecutor()
    const val ALARM = "app.savemywallet.ledger.PET_REMINDER"
    private const val CHANNEL = "pet-reminders"

    fun logFailure(failure: Exception) {
        Log.w("PetReminders", "Android reminder delivery failed (${failure.javaClass.simpleName})")
    }

    private fun store(context: Context) = context.getSharedPreferences(CHANNEL, Context.MODE_PRIVATE)

    fun allowed(context: Context): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL,
                context.getString(R.string.pet_reminder_channel), NotificationManager.IMPORTANCE_DEFAULT))
            val channel = manager.getNotificationChannel(CHANNEL) ?: return false
            return channel.importance != NotificationManager.IMPORTANCE_NONE
        }
        return true
    }

    fun post(context: Context, id: Int, title: String, body: String, recurring: Boolean = false) {
        if (!allowed(context)) throw SecurityException("REMINDER_PERMISSION")
        val openApp = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val notice = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_pet_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            // Test alerts reuse ID 0 so they replace the preview but alert on every tap.
            .setOnlyAlertOnce(id != 0 && !recurring)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(CHANNEL, id, notice)
    }

    private fun alarmIntent(context: Context, id: Int, flags: Int): PendingIntent? {
        val intent = Intent(context, PetReminderReceiver::class.java).setAction(ALARM).putExtra("id", id)
        return PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_IMMUTABLE or flags)
    }

    private fun arm(context: Context, id: Int, at: Long) {
        val manager = context.getSystemService(AlarmManager::class.java)
        val trigger = checkNotNull(alarmIntent(context, id, PendingIntent.FLAG_UPDATE_CURRENT))
        if (Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()) {
            try {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, trigger)
                return
            } catch (_: SecurityException) {
                // Exact alarm access can change between the check and registration.
            }
        }
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, trigger)
    }

    private fun readRule(json: JSONObject): PetReminderRecurrence = when (val frequency = json.getString("frequency")) {
        "interval" -> PetReminderRecurrence.Interval(json.getInt("minutes"), json.getLong("anchorAt"))
        "randomWindow" -> PetReminderRecurrence.RandomWindow(
            json.getString("startTime"), json.getString("endTime"), json.getInt("seed"))
        else -> PetReminderRecurrence.CalendarRule(frequency, json.getString("time"),
            if (json.has("weekday")) json.getInt("weekday") else null,
            if (json.has("dayOfMonth")) json.getInt("dayOfMonth") else null)
    }

    fun schedule(context: Context, id: Int, at: Long, title: String, body: String, recurrence: JSONObject?) {
        if (!allowed(context)) throw SecurityException("REMINDER_PERMISSION")
        val value = JSONObject().put("at", at).put("title", title).put("body", body)
        if (recurrence != null) {
            val zone = TimeZone.getDefault()
            val rule = readRule(recurrence)
            require(rule.nextAfter(at - 1, zone) == at)
            val now = System.currentTimeMillis()
            // The activity may be editing the wording after the receiver already delivered a
            // notification. A retry with the same rule must preserve its consumed slot.
            val old = store(context).getString(id.toString(), null)?.let(::JSONObject)
            val sameRule = old?.optJSONObject("recurrence")?.let(::readRule) == rule
            val lastDay = if (sameRule) old!!.optInt("lastLocalDay") else 0
            val first = rule.nextAfter(at - 1, zone, lastDay)
            val effective = if (sameRule && rule is PetReminderRecurrence.Interval)
                maxOf(first, old!!.getLong("at")) else first
            val after = if (rule.nextAfter(now, zone, lastDay) == effective) now else effective - 1
            value.put("at", effective).put("recurrence", recurrence).put("zone", zone.id)
                .put("after", after).put("lastLocalDay", lastDay)
        }
        saveAndArm(context, id, value)
    }

    private fun saveAndArm(context: Context, id: Int, value: JSONObject) {
        val prefs = store(context)
        val key = id.toString()
        val old = prefs.getString(key, null)
        try {
            check(prefs.edit().putString(key, value.toString()).commit())
            arm(context, id, value.getLong("at"))
        } catch (failure: Exception) {
            check(prefs.edit().putString(key, old).commit())
            throw failure
        }
    }

    fun cancel(context: Context, id: Int) {
        val prefs = store(context)
        val key = id.toString()
        val previous = prefs.getString(key, null)
        val pending = alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE)
        if (pending != null) context.getSystemService(AlarmManager::class.java).cancel(pending)
        if (!prefs.edit().remove(key).commit()) {
            if (previous != null) {
                prefs.edit().putString(key, previous).commit()
                arm(context, id, JSONObject(previous).getLong("at"))
            }
            throw IllegalStateException("REMINDER_DELIVERY")
        }
        pending?.cancel()
        context.getSystemService(NotificationManager::class.java).cancel(CHANNEL, id)
    }

    fun deliver(context: Context, id: Int) {
        val reminder = store(context).getString(id.toString(), null)?.let(::JSONObject) ?: return
        reconcile(context, id, reminder)
    }

    private fun reconcile(context: Context, id: Int, reminder: JSONObject) {
        var at = reminder.getLong("at")
        val now = System.currentTimeMillis()
        val zone = TimeZone.getDefault()
        val rule = reminder.optJSONObject("recurrence")?.let(::readRule)
        val lastDay = reminder.optInt("lastLocalDay")
        val zoneChanged = rule is PetReminderRecurrence.Civil && reminder.optString("zone") != zone.id
        if (zoneChanged) {
            at = rule.nextAfter(reminder.getLong("after"), zone, lastDay)
            reminder.put("at", at).put("zone", zone.id)
        }
        if (at > now) {
            // An alarm from before an edit can already be in the receiver queue.
            if (zoneChanged) saveAndArm(context, id, reminder) else arm(context, id, at)
            return
        }
        if (rule != null) {
            // Advance the series before posting. Boot, permission callbacks, and already
            // queued alarm broadcasts can all reconcile the same outstanding occurrence.
            val advance = rule.advanceDue(now, zone)
            saveAndArm(context, id, reminder.put("at", advance.nextAt)
                .put("lastLocalDay", advance.lastLocalDay).put("after", now))
            if (!advance.notify) return
        }
        try {
            post(context, id, reminder.getString("title"), reminder.getString("body"), rule != null)
        } catch (_: SecurityException) {
            // Permission may have been revoked while a posted alarm was waking the process.
            return
        }
        if (rule == null) check(store(context).edit().remove(id.toString()).commit())
    }

    fun restore(context: Context) {
        for ((key, value) in store(context).all) {
            val id = key.toIntOrNull() ?: continue
            if (value !is String) continue
            try {
                reconcile(context, id, JSONObject(value))
            } catch (failure: Exception) {
                logFailure(failure)
            }
        }
    }
}
