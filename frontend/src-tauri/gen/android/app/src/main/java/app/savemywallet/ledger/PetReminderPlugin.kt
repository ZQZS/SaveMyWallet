package app.savemywallet.ledger

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin(permissions = [
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
])
class PetReminderPlugin(private val host: Activity) : Plugin(host) {
    private val context = host.applicationContext
    private val permissionWaiters = mutableListOf<Invoke>()

    override fun load(webView: WebView) {
        PetReminders.worker.execute { PetReminders.restore(context) }
    }

    @Command
    fun permission(invoke: Invoke) {
        host.runOnUiThread {
            if (invoke.getArgs().optBoolean("request") && Build.VERSION.SDK_INT >= 33 &&
                context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionWaiters.add(invoke)
                if (permissionWaiters.size == 1) {
                    requestPermissionForAlias("notifications", invoke, "notificationPermissionResult")
                }
            } else {
                invoke.resolve(JSObject().apply { put("granted", PetReminders.allowed(context)) })
            }
        }
    }

    @PermissionCallback
    fun notificationPermissionResult(invoke: Invoke) {
        val granted = PetReminders.allowed(context)
        val waiters = permissionWaiters.toList().ifEmpty { listOf(invoke) }
        permissionWaiters.clear()
        for (waiter in waiters) waiter.resolve(JSObject().apply { put("granted", granted) })
        if (granted) PetReminders.worker.execute { PetReminders.restore(context) }
    }

    private fun run(invoke: Invoke, operation: () -> Unit) {
        PetReminders.worker.execute {
            try {
                operation()
                invoke.resolve()
            } catch (_: SecurityException) {
                invoke.reject("REMINDER_PERMISSION")
            } catch (_: Exception) {
                invoke.reject("REMINDER_DELIVERY")
            }
        }
    }

    @Command
    fun notifyNow(invoke: Invoke) = run(invoke) {
        val args = invoke.getArgs()
        PetReminders.post(context, args.getInt("id"), args.getString("title"), args.getString("body"))
    }

    @Command
    fun schedule(invoke: Invoke) = run(invoke) {
        val args = invoke.getArgs()
        PetReminders.schedule(context, args.getInt("id"), args.getLong("at"),
            args.getString("title"), args.getString("body"), args.optJSONObject("recurrence"))
    }

    @Command
    fun cancel(invoke: Invoke) = run(invoke) {
        PetReminders.cancel(context, invoke.getArgs().getInt("id"))
    }
}
