package com.leoyuan.leophoneagent.relay

import android.content.Context
import com.leoyuan.leophoneagent.util.EncryptedPrefsFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Keeps the relay bearer key in Android Keystore-backed preferences. */
class RelayFleetStore(context: Context) {
    private val prefs = EncryptedPrefsFactory.safeCreate(
        context.applicationContext,
        "leo_relay_fleet_secure",
    )
    private val json = Json { ignoreUnknownKeys = true }
    private val _config = MutableStateFlow(load())
    val config: StateFlow<RelayFleetConfig> = _config.asStateFlow()

    fun save(base: String, rawKey: String) {
        val normalizedBase = normalizeBase(base)
        val key = rawKey.trim().trimEnd('%').trim()
        require(key.length >= 16) { "中继密钥至少需要 16 个字符" }
        val next = _config.value.copy(relayApiBase = normalizedBase, accessKey = key)
        persist(next)
    }

    fun ensureMachineName(fallback: String): String {
        val current = _config.value.machineName.trim()
        if (current.isNotEmpty()) return current
        val name = fallback.trim().ifBlank { "android-body" }
        persist(_config.value.copy(machineName = name))
        return name
    }

    fun clear() {
        prefs.edit().remove(KEY_CONFIG).apply()
        _config.value = RelayFleetConfig()
    }

    private fun persist(next: RelayFleetConfig) {
        prefs.edit().putString(KEY_CONFIG, json.encodeToString(next)).apply()
        _config.value = next
    }

    private fun load(): RelayFleetConfig {
        val raw = prefs.getString(KEY_CONFIG, null) ?: return RelayFleetConfig()
        return runCatching { json.decodeFromString<RelayFleetConfig>(raw) }
            .getOrDefault(RelayFleetConfig())
    }

    companion object {
        private const val KEY_CONFIG = "config"

        internal fun normalizeBase(raw: String): String {
            val value = raw.trim().trimEnd('/')
            val url = java.net.URI(value)
            require(url.scheme.equals("https", ignoreCase = true) && !url.host.isNullOrBlank()) {
                "中继地址必须是有效的 HTTPS URL"
            }
            require(url.userInfo == null && url.fragment == null) {
                "中继地址不能包含账号或片段"
            }
            return value
        }
    }
}
