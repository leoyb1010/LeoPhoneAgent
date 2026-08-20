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
 * Strategy（每一档的作用域都严格限于**这一个** store —— 见 P1#14）:
 *  1. Try the normal create（沿用共享的 DEFAULT_MASTER_KEY_ALIAS，
 *     所以老数据照常读得出来）。
 *  2. On any crypto error: 只删这个 store 自己的 `$fileName.xml`
 *     （数据 + 它的 Tink keyset 都在里面），retry once。
 *     用户只丢这一个 store 的凭据。
 *  3. 还失败 → 说明共享主密钥本身不可用：给这个 store 换一把专属别名
 *     （`leo_mk_<file>`）重建，并把这次降级记进明文别名账本，后续冷启动
 *     直接用它。**不删共享别名**，其它 store 的凭据毫发无损。
 *  4. If recreate still fails: fail closed with an in-memory preferences
 *     implementation. The app can still boot and the current process can use
 *     newly entered credentials, but no secret is persisted without working
 *     Android Keystore encryption. A restart therefore requires login again.
 */
object EncryptedPrefsFactory {
    private const val TAG = "EncryptedPrefsFactory"

    /** 记录"哪个 store 已经降级到专属主密钥别名"的明文小账本（不含任何秘密）。 */
    private const val ALIAS_BOOK = "encrypted_prefs_alias_book"
    private const val ALIAS_PREFIX = "leo_mk_"

    fun safeCreate(context: Context, fileName: String): SharedPreferences {
        // 曾经因为共享主密钥不可用而降级过的 store，直接走它自己的专属别名，
        // 否则每次冷启动都要先失败一次、再擦一次数据。
        val pinned = pinnedAlias(context, fileName)
        val primaryAlias = pinned ?: MasterKey.DEFAULT_MASTER_KEY_ALIAS

        runCatching { return build(context, fileName, primaryAlias) }
            .onFailure { Log.w(TAG, "first create($fileName) failed: ${it.message}") }

        // 第一档自愈：**只**删这个 store 自己的 XML 文件。
        //
        // why 不再删共享主密钥别名（review P1#14）：原来的 wipeEncryptedState 删的
        // 是共享的 `MasterKey.DEFAULT_MASTER_KEY_ALIAS` —— relay store 一处 AEAD
        // 失败，就把 provider API Key、OAuth token 全部连坐报废。而且它删的那个
        // `__androidx_security_crypto_encrypted_prefs__.xml` 根本不是 Tink 存
        // keyset 的地方：androidx.security 用
        // `AndroidKeysetManager.withSharedPref(context, keysetName, prefFileName)`，
        // 两份 keyset（key/value）都存在**这个 store 自己的**
        // `$fileName.xml` 里，键名是
        // `__androidx_security_crypto_encrypted_prefs_key_keyset__` /
        // `..._value_keyset__`。所以删 `$fileName.xml` 一步就同时清掉了数据和
        // 它的 keyset，作用域刚好是这一个 store，且完全够用。
        wipeStoreFile(context, fileName)

        runCatching { return build(context, fileName, primaryAlias) }
            .onFailure { Log.w(TAG, "rebuild($fileName) after wipe failed: ${it.message}") }

        // 第二档自愈：共享主密钥本身坏了（备份恢复 / Keystore 重置后
        // KeyPermanentlyInvalidated 之类）。给这个 store 换一把**它专属的**
        // 主密钥别名重来一次，仍然不碰别的 store 的密钥。
        val fallbackAlias = fallbackAliasFor(fileName)
        runCatching {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (ks.containsAlias(fallbackAlias)) ks.deleteEntry(fallbackAlias)
        }.onFailure { Log.w(TAG, "drop stale per-store alias failed: ${it.message}") }
        wipeStoreFile(context, fileName)
        runCatching {
            val prefs = build(context, fileName, fallbackAlias)
            // 记住这次降级，让后续冷启动直接用专属别名。
            pinAlias(context, fileName, fallbackAlias)
            Log.w(TAG, "recovered $fileName with a dedicated master key alias")
            return prefs
        }.onFailure {
            Log.e(TAG, "rebuild($fileName) with dedicated alias failed: ${it.message}", it)
        }

        // Remove files written by builds that used the former plaintext
        // fallback before returning an ephemeral store.
        runCatching {
            context.deleteSharedPreferences("${fileName}_plain_fallback")
        }.onFailure { Log.w(TAG, "failed to delete legacy plaintext fallback: ${it.message}") }
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

    /**
     * 只删这个 store 自己的 XML。里面同时装着密文数据和它的 Tink keyset，
     * 删掉后 create() 会重新生成两者 —— 影响范围严格限于本 store。
     */
    private fun wipeStoreFile(context: Context, fileName: String) {
        runCatching {
            val dir = File(context.applicationInfo.dataDir, "shared_prefs")
            File(dir, "$fileName.xml").delete()
        }.onFailure { Log.w(TAG, "wipe $fileName.xml failed: ${it.message}") }
    }

    /** Keystore 别名只允许有限字符集，这里把文件名规整一下。 */
    internal fun fallbackAliasFor(fileName: String): String =
        ALIAS_PREFIX + fileName.replace(Regex("[^A-Za-z0-9_]"), "_")

    private fun aliasBook(context: Context): SharedPreferences =
        context.getSharedPreferences(ALIAS_BOOK, Context.MODE_PRIVATE)

    private fun pinnedAlias(context: Context, fileName: String): String? =
        runCatching { aliasBook(context).getString(fileName, null) }.getOrNull()

    private fun pinAlias(context: Context, fileName: String, alias: String) {
        runCatching { aliasBook(context).edit().putString(fileName, alias).apply() }
            .onFailure { Log.w(TAG, "pin alias failed: ${it.message}") }
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
