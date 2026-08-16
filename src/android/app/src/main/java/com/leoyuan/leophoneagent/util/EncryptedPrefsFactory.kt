package com.leoyuan.leophoneagent.util

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

/**
 * T-android-keystore-aead-fail: self-healing wrapper around
 * [EncryptedSharedPreferences.create].
 *
 * The default flow throws `AEADBadTagException` (wrapped as
 * `GeneralSecurityException`) on launch when the AndroidKeystore master
 * key can no longer decrypt the Tink keyset blob — observed on Samsung
 * One UI / Android 16 after backup-restore or biometric re-enroll. The
 * exception bubbles to the main thread and the app dies in a relaunch
 * loop because every cold start hits the same lazy init.
 *
 * Strategy:
 *  1. Try the normal create.
 *  2. On any crypto error: drop the encrypted XML file + the on-disk
 *     Tink keyset prefs file + the AndroidKeystore alias, then retry
 *     once. The user loses stored credentials (they need to re-paste
 *     their API key / re-login OAuth) but the app boots.
 *  3. If recreate still fails: fail closed with an in-memory preferences
 *     implementation. The app can still boot and the current process can use
 *     newly entered credentials, but no secret is persisted without working
 *     Android Keystore encryption. A restart therefore requires login again.
 */
object EncryptedPrefsFactory {
    private const val TAG = "EncryptedPrefsFactory"

    fun safeCreate(context: Context, fileName: String): SharedPreferences {
        runCatching { return build(context, fileName) }
            .onFailure { Log.w(TAG, "first create($fileName) failed: ${it.message}") }

        // First wipe attempt — the encrypted XML + Tink keyset blob +
        // master-key alias all need to go. The Tink keyset lives in its
        // own __androidx_security_crypto_encrypted_prefs__ file keyed
        // by the SP file name; drop both so create() regenerates them.
        wipeEncryptedState(context, fileName)

        runCatching { return build(context, fileName) }
            .onFailure {
                Log.e(TAG, "rebuild($fileName) after wipe failed: ${it.message}", it)
            }

        // Remove files written by builds that used the former plaintext
        // fallback before returning an ephemeral store.
        runCatching {
            context.deleteSharedPreferences("${fileName}_plain_fallback")
        }.onFailure { Log.w(TAG, "failed to delete legacy plaintext fallback: ${it.message}") }
        Log.e(TAG, "secure storage unavailable for $fileName; using non-persistent memory store")
        return MemoryOnlySharedPreferences()
    }

    private fun build(context: Context, fileName: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            fileName,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private fun wipeEncryptedState(context: Context, fileName: String) {
        // XML file the SP itself reads/writes.
        runCatching {
            val dir = File(context.applicationInfo.dataDir, "shared_prefs")
            File(dir, "$fileName.xml").delete()
            // Tink keyset blob is stashed in this companion prefs file.
            File(dir, "__androidx_security_crypto_encrypted_prefs__.xml").delete()
        }.onFailure { Log.w(TAG, "wipe prefs files failed: ${it.message}") }

        runCatching {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (ks.containsAlias(MasterKey.DEFAULT_MASTER_KEY_ALIAS)) {
                ks.deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            }
        }.onFailure { Log.w(TAG, "wipe master-key alias failed: ${it.message}") }
    }

    /**
     * Process-local, non-persistent fallback used only when Android Keystore
     * cannot be recreated. This intentionally behaves like an empty store on
     * every process start; it must never write credentials to disk.
     */
    private class MemoryOnlySharedPreferences : SharedPreferences {
        private val values = ConcurrentHashMap<String, Any>()
        private val listeners = CopyOnWriteArraySet<SharedPreferences.OnSharedPreferenceChangeListener>()

        override fun getAll(): Map<String, *> = HashMap(values)
        override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            @Suppress("UNCHECKED_CAST")
            ((values[key] as? Set<String>)?.toMutableSet() ?: defValues)
        override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String?): Boolean = key != null && values.containsKey(key)
        override fun edit(): SharedPreferences.Editor = MemoryEditor()
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {
            listener?.let(listeners::add)
        }
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {
            listener?.let(listeners::remove)
        }

        private inner class MemoryEditor : SharedPreferences.Editor {
            private val updates = LinkedHashMap<String, Any?>()
            private var clearRequested = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply { updates[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor =
                apply { updates[key] = values?.toSet() }
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply { updates[key] = value }
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply { updates[key] = value }
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply { updates[key] = value }
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply { updates[key] = value }
            override fun remove(key: String): SharedPreferences.Editor = apply { updates[key] = null }
            override fun clear(): SharedPreferences.Editor = apply { clearRequested = true }
            override fun commit(): Boolean {
                val changed = LinkedHashSet<String>()
                synchronized(values) {
                    if (clearRequested) {
                        changed.addAll(values.keys)
                        values.clear()
                    }
                    updates.forEach { (key, value) ->
                        changed += key
                        if (value == null) values.remove(key) else values[key] = value
                    }
                }
                changed.forEach { key -> listeners.forEach { it.onSharedPreferenceChanged(this@MemoryOnlySharedPreferences, key) } }
                return true
            }
            override fun apply() { commit() }
        }
    }
}
