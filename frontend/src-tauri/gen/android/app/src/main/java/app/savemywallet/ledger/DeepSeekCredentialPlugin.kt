package app.savemywallet.ledger

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@TauriPlugin
class DeepSeekCredentialPlugin(activity: Activity) : Plugin(activity) {
    private val context = activity.applicationContext
    private val alias = "${context.packageName}/DeepSeek"
    private val preferences by lazy { context.getSharedPreferences("deepseek-credentials", Context.MODE_PRIVATE) }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        // Serialize replacements/removals, including while Android recreates the activity.
        val worker = Executors.newSingleThreadExecutor()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun newKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply { init(spec) }.generateKey()
    }

    private fun run(invoke: Invoke, operation: () -> String?) {
        worker.execute {
            try {
                val result = operation()
                if (result == null) invoke.resolve() else invoke.resolveObject(result)
            } catch (_: Exception) {
                invoke.reject("AI_KEY_STORAGE")
            }
        }
    }

    @Command
    fun saveKey(invoke: Invoke) = run(invoke) {
        val key = keyStore().getKey(alias, null) as? SecretKey ?: newKey()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // AndroidKeyStore chooses a fresh IV for each encryption.
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val plain = invoke.getArgs().getString("key").toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        check(preferences.edit()
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .commit())
        null
    }

    @Command
    fun readKey(invoke: Invoke) = run(invoke) {
        val encrypted = preferences.getString("ciphertext", null) ?: return@run null
        val iv = Base64.decode(checkNotNull(preferences.getString("iv", null)), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyStore().getKey(alias, null), GCMParameterSpec(128, iv))
        val plain = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP))
        try { String(plain, Charsets.UTF_8) } finally { plain.fill(0) }
    }

    @Command
    fun removeKey(invoke: Invoke) = run(invoke) {
        check(preferences.edit().clear().commit())
        val store = keyStore()
        if (store.containsAlias(alias)) store.deleteEntry(alias)
        null
    }
}
