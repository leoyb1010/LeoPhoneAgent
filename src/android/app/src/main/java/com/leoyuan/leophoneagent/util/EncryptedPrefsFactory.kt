package com.leoyuan.leophoneagent.util

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

/** Encrypted storage initialization is non-destructive. Temporary platform failures
 * preserve ciphertext and aliases; the user is warned before using ephemeral values.
 */
object EncryptedPrefsFactory {
    private const val TAG = "EncryptedPrefsFactory"

    /** 记录"哪个 store 已经降级到专属主密钥别名"的明文小账本（不含任何秘密）。 */
    private const val ALIAS_BOOK = "encrypted_prefs_alias_book"

    fun safeCreate(context: Context, fileName: String): SharedPreferences {
        // 曾经因为共享主密钥不可用而降级过的 store，直接走它自己的专属别名，
        // 否则每次冷启动都要先失败一次、再擦一次数据。
        val pinned = pinnedAlias(context, fileName)
        val primaryAlias = pinned ?: MasterKey.DEFAULT_MASTER_KEY_ALIAS

        // 初始化异常不能证明密文永久损坏。两次都使用原档案和原 alias。
        EncryptedPrefsRecovery.open(
            create = { build(context, fileName, primaryAlias) },
            failed = { Log.w(TAG, "create($fileName) failed; encrypted file and alias preserved") },
        )?.let { return it }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            android.widget.Toast.makeText(context.applicationContext,
                com.leoyuan.leophoneagent.R.string.secure_storage_temporarily_unavailable,
                android.widget.Toast.LENGTH_LONG).show()
        }

        Log.e(TAG, "secure storage unavailable for $fileName; using non-persistent memory store")
        return MemoryOnlySharedPreferences()
    }

    private fun build(context: Context, fileName: String, masterKeyAlias: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context, masterKeyAlias)
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

    private fun aliasBook(context: Context): SharedPreferences =
        context.getSharedPreferences(ALIAS_BOOK, Context.MODE_PRIVATE)

    private fun pinnedAlias(context: Context, fileName: String): String? =
        runCatching { aliasBook(context).getString(fileName, null) }.getOrNull()

    /**
     * Process-local, non-persistent fallback used only when Android Keystore
     * is temporarily unavailable. This intentionally behaves like an empty store on
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
                // 内存更新可用，但不能向 commit 调用者宣称已持久化。
                return false
            }
            override fun apply() { commit() }
        }
    }
}
