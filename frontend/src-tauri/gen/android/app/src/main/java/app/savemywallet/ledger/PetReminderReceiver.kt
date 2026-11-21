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
import java.util.concurrent.Executors

class PetReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        PetReminders.worker.execute {
            try {
                when (intent.action) {
                    Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> PetReminders.restore(context)
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

    fun post(context: Context, id: Int, title: String, body: String) {
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
            .setOnlyAlertOnce(true)
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

    fun schedule(context: Context, id: Int, at: Long, title: String, body: String) {
        if (!allowed(context)) throw SecurityException("REMINDER_PERMISSION")
        val prefs = store(context)
        val key = id.toString()
        val old = prefs.getString(key, null)
        val value = JSONObject().put("at", at).put("title", title).put("body", body)
        check(prefs.edit().putString(key, value.toString()).commit())
        try {
            arm(context, id, at)
        } catch (failure: Exception) {
            check(prefs.edit().putString(key, old).commit())
            throw failure
        }
    }

    fun cancel(context: Context, id: Int) {
        check(store(context).edit().remove(id.toString()).commit())
        alarmIntent(context, id, PendingIntent.FLAG_NO_CREATE)?.let {
            context.getSystemService(AlarmManager::class.java).cancel(it)
            it.cancel()
        }
        context.getSystemService(NotificationManager::class.java).cancel(CHANNEL, id)
    }

    fun deliver(context: Context, id: Int) {
        val prefs = store(context)
        val key = id.toString()
        val reminder = prefs.getString(key, null)?.let(::JSONObject) ?: return
        if (reminder.getLong("at") > System.currentTimeMillis()) return
        try {
            post(context, id, reminder.getString("title"), reminder.getString("body"))
        } catch (_: SecurityException) {
            // Permission may have been revoked while a posted alarm was waking the process.
            return
        }
        prefs.edit().remove(key).commit()
    }

    fun restore(context: Context) {
        for ((key, value) in store(context).all) {
            val id = key.toIntOrNull() ?: continue
            if (value !is String) continue
            try {
                val at = JSONObject(value).getLong("at")
                if (at <= System.currentTimeMillis()) deliver(context, id) else arm(context, id, at)
            } catch (failure: Exception) {
                logFailure(failure)
            }
        }
    }
}
