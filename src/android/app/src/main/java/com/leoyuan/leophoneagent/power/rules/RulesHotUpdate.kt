package com.leoyuan.leophoneagent.power.rules

import java.io.File
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.util.Locale

data class RulesManifest(
    val schemaVersion: Int,
    val sha256: String,
    val signature: String,
    val minAppVersion: String,
    val rollbackTo: String,
    val host: String? = null,
)

sealed class HotUpdateResult {
    data class Applied(val ruleCount: Int, val fromLkg: Boolean = false) : HotUpdateResult()
    data class Rejected(val reason: String) : HotUpdateResult()
}

object RulesHotUpdate {
    val ALLOW_HOSTS = setOf("raw.githubusercontent.com", "github.com")

    fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }

    fun bundledManifest(minAppVersion: String = "1.0.0-alpha.17"): RulesManifest {
        val payload = AppRules.BUNDLED_JSON.trim().toByteArray()
        return RulesManifest(
            schemaVersion = 1,
            sha256 = sha256Hex(payload),
            signature = "bundled",
            minAppVersion = minAppVersion,
            rollbackTo = "bundled-1",
        )
    }

    fun apply(
        root: File,
        payload: ByteArray,
        manifest: RulesManifest,
        currentAppVersion: String,
        disabled: Boolean = false,
        publicKey: PublicKey? = null,
    ): HotUpdateResult {
        if (disabled) return HotUpdateResult.Rejected("user-disabled")
        manifest.host?.let { host ->
            if (host !in ALLOW_HOSTS) return HotUpdateResult.Rejected("host-not-allowed")
        }
        if (manifest.schemaVersion != 1) return HotUpdateResult.Rejected("schema")
        if (compareVersion(currentAppVersion, manifest.minAppVersion) < 0) {
            return HotUpdateResult.Rejected("min-app-version")
        }
        val text = payload.toString(Charsets.UTF_8)
        if (text.contains("\"bytecode\"") || text.contains(".dex") || text.contains(".so")) {
            return HotUpdateResult.Rejected("code-payload")
        }
        if (sha256Hex(payload) != manifest.sha256.lowercase(Locale.US)) {
            return HotUpdateResult.Rejected("sha256")
        }
        if (manifest.host != null) {
            if (publicKey == null || !verifyRsa(payload, manifest.signature, publicKey)) {
                return HotUpdateResult.Rejected("signature")
            }
        } else if (manifest.signature != "bundled") {
            return HotUpdateResult.Rejected("signature")
        }
        val parsed = runCatching { AppRules.parse(text) }.getOrElse {
            return HotUpdateResult.Rejected("parse:${it.message}")
        }
        val current = File(root, "current/rules.json")
        val lkg = File(root, "lkg/rules.json")
        val staging = File(root, "staging/rules.json")
        if (current.isFile) {
            lkg.parentFile.mkdirs()
            current.copyTo(lkg, overwrite = true)
        }
        staging.parentFile.mkdirs()
        staging.writeBytes(payload)
        current.parentFile.mkdirs()
        if (current.exists()) current.delete()
        if (!staging.renameTo(current)) {
            staging.copyTo(current, overwrite = true)
            staging.delete()
        }
        val ok = runCatching { AppRules.parse(current.readText()) }.isSuccess
        if (!ok) {
            if (lkg.isFile) {
                lkg.copyTo(current, overwrite = true)
                return HotUpdateResult.Applied(AppRules.parse(current.readText()).size, fromLkg = true)
            }
            return HotUpdateResult.Rejected("activate-failed")
        }
        return HotUpdateResult.Applied(parsed.size)
    }

    fun loadActive(root: File): List<com.leoyuan.leophoneagent.power.rules.AppRule> {
        val current = File(root, "current/rules.json")
        if (current.isFile) return AppRules.parse(current.readText())
        return AppRules.bundled()
    }

    fun compareVersion(a: String, b: String): Int {
        fun parts(v: String) = v.split(Regex("""[^0-9]+""")).mapNotNull { it.toIntOrNull() }
        val pa = parts(a)
        val pb = parts(b)
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val da = pa.getOrElse(i) { 0 }
            val db = pb.getOrElse(i) { 0 }
            if (da != db) return da.compareTo(db)
        }
        return 0
    }

    private fun verifyRsa(payload: ByteArray, signatureHex: String, key: PublicKey): Boolean {
        val sig = signatureHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(key)
        verifier.update(payload)
        return runCatching { verifier.verify(sig) }.getOrDefault(false)
    }
}
