package com.leoyuan.leophoneagent.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import com.leoyuan.leophoneagent.BuildConfig
import com.leoyuan.leophoneagent.logging.AppLogger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * Checks GitHub releases for an APK newer than [BuildConfig.VERSION_NAME] and
 * coordinates download → install. iOS has no equivalent (sideloading is not
 * permitted) so this is Android-only.
 *
 * Comparison strategy: keep the Android alpha sequence (`alpha.24` →
 * `alpha.25`), strip only repository/flavor decoration, then compare numeric
 * components. iOS/Mac tags in the same repository are ignored.
 */
object UpdateChecker {

    private const val TAG = "UpdateChecker"
    private const val OWNER = "leoyb1010"
    private const val REPO = "LeoPhoneAgent"
    private val DOWNLOAD_FILENAME: String
        get() = if (BuildConfig.POWER_FEATURES_ENABLED) {
            "leophoneagent-power-update.apk"
        } else {
            "leophoneagent-standard-update.apk"
        }
    /**
     * Sub-directory of `filesDir` where we stage downloaded update APKs. We
     * moved off `cacheDir/shared/` (the original location) so the OS can't
     * evict a freshly-downloaded APK between the moment we hand the user off
     * to "install unknown apps" settings and the moment they return — the
     * eviction was a contributing factor to the "re-download after grant"
     * bug. See [PendingUpdateStore]. Exposed via `file_provider_paths.xml`
     * `<files-path name="updates" path="updates/" />`.
     */
    private const val UPDATES_DIR = "updates"

    sealed class CheckResult {
        data class UpdateAvailable(
            val tagName: String,
            val versionName: String,
            val releaseName: String,
            val changelog: String,
            val apkUrl: String,
            val apkSizeBytes: Long,
            val expectedSha256: String,
        ) : CheckResult()
        data object UpToDate : CheckResult()
        // The repo has zero non-draft releases (or 404'd entirely).
        data object NoReleaseAvailable : CheckResult()
        // A newer release exists but no .apk asset was attached. Distinct
        // from NoReleaseAvailable so the UI can say "newer release exists,
        // but it didn't ship an APK" instead of misleading "no release yet".
        data class NoApkAsset(val tagName: String) : CheckResult()
        data class Error(val message: String) : CheckResult()
        // GitHub returned 403 / 451 — usually a geo-block or rate-limit in CN
        // without a VPN. UI surfaces a hint with a clickable Releases link.
        data object Forbidden : CheckResult()
        // DNS / connect / read timeout — network unreachable. UI nudges the
        // user to check connectivity and retry.
        data object NetworkUnreachable : CheckResult()
    }

    sealed class DownloadResult {
        data class Success(val file: File) : DownloadResult()
        data class Error(val message: String) : DownloadResult()
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * Hit `repos/{owner}/{repo}/releases` (the list endpoint, NOT
     * `/releases/latest`), pick the highest-version non-draft release that
     * carries an APK asset, and decide whether the user should upgrade.
     *
     * T133: switched from `/releases/latest` to `/releases` because
     * `/releases/latest` excludes prereleases by GitHub design — our
     * `0.1 preview` release is flagged as a prerelease, so the old endpoint
     * 404'd and the UI falsely showed "No release published yet". The list
     * endpoint includes prereleases; we filter drafts client-side.
     *
     * All network work happens on [Dispatchers.IO]; safe to call from any
     * coroutine scope.
     */
    suspend fun check(): CheckResult = withContext(Dispatchers.IO) {
        val url = "https://api.github.com/repos/$OWNER/$REPO/releases?per_page=30"
        AppLogger.info(TAG, "GET $url (local=${BuildConfig.VERSION_NAME})")
        try {
            val req = Request.Builder()
                .url(url)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .build()
            client.newCall(req).execute().use { resp ->
                AppLogger.info(TAG, "HTTP ${resp.code}")
                if (resp.code == 404) {
                    return@withContext CheckResult.NoReleaseAvailable
                }
                // 403 = rate-limit or geo-blocked. 451 = legal block. Both
                // map to the same "open Releases in browser" hint — there's
                // nothing the app can do client-side.
                if (resp.code == 403 || resp.code == 451) {
                    AppLogger.warning(TAG, "GitHub API ${resp.code} — geo-block or rate-limit")
                    return@withContext CheckResult.Forbidden
                }
                if (!resp.isSuccessful) {
                    val msg = "GitHub API ${resp.code}"
                    AppLogger.warning(TAG, msg)
                    return@withContext CheckResult.Error(msg)
                }
                val body = resp.body?.string() ?: return@withContext CheckResult.Error("empty body")
                val arr = runCatching { JSONArray(body) }.getOrNull()
                if (arr == null || arr.length() == 0) {
                    AppLogger.info(TAG, "releases list empty")
                    return@withContext CheckResult.NoReleaseAvailable
                }

                // Build a list of non-draft releases. GitHub already returns
                // them sorted by created_at desc, but we re-sort by parsed
                // version number to be robust against odd ordering.
                data class ReleaseInfo(
                    val tagName: String,
                    val versionName: String,
                    val releaseName: String,
                    val changelog: String,
                    val isPrerelease: Boolean,
                    val apkUrl: String?,
                    val apkSize: Long,
                    val expectedSha256: String?,
                )

                val candidates = mutableListOf<ReleaseInfo>()
                for (i in 0 until arr.length()) {
                    val r = arr.optJSONObject(i) ?: continue
                    if (r.optBoolean("draft", false)) continue
                    val tag = r.optString("tag_name")
                    if (tag.isEmpty()) continue
                    val (apkUrl, apkSize) = findApkAsset(r.optJSONArray("assets"))
                    // This repository also publishes iOS and Mac releases.
                    // They must not outrank Android and produce a false
                    // "new release has no APK" result.
                    if (apkUrl == null && !tag.startsWith("android-", ignoreCase = true)) continue
                    candidates += ReleaseInfo(
                        tagName = tag,
                        versionName = normalizeTag(tag),
                        releaseName = r.optString("name").ifEmpty { tag },
                        changelog = r.optString("body", ""),
                        isPrerelease = r.optBoolean("prerelease", false),
                        apkUrl = apkUrl,
                        apkSize = apkSize,
                        expectedSha256 = releaseSha256(
                            r.optString("body", ""),
                            power = BuildConfig.POWER_FEATURES_ENABLED,
                        ),
                    )
                }
                AppLogger.info(
                    TAG,
                    "non-draft releases=${candidates.size} (apk-bearing=${candidates.count { it.apkUrl != null }})",
                )
                if (candidates.isEmpty()) {
                    return@withContext CheckResult.NoReleaseAvailable
                }

                // [T-android-updatechecker-localver-normalize] Normalize the
                // LOCAL version the same way remote tags are (normalizeTag),
                // otherwise the comparison is asymmetric: remote "v0.11-preview"
                // becomes "0.11" but local "0.11-preview" stays raw, and
                // compareVersions("0.11","0.11-preview") puts "" before
                // "preview" in the 3rd component → remote judged OLDER → the
                // user is told they're up to date when they're actually on the
                // matching version (and a real newer "0.12-preview" → "0.12"
                // still compares greater, so updates still surface).
                val localVer = normalizeTag(BuildConfig.VERSION_NAME)
                // Highest version we've seen at all (used for the "release
                // exists but is older or equal" → UpToDate decision and for
                // logging).
                val versionOrder = Comparator<ReleaseInfo> { left, right ->
                    compareVersions(left.versionName, right.versionName)
                }
                val highest = candidates.maxWithOrNull(versionOrder) ?: candidates.first()
                AppLogger.info(
                    TAG,
                    "highest-published tag=${highest.tagName} parsed=${highest.versionName} prerelease=${highest.isPrerelease} apk=${highest.apkUrl != null}",
                )

                // First APK-bearing release with version > local. We pick the
                // highest such release so a stale older APK never shadows a
                // newer non-APK preview.
                val upgradeCandidate = candidates
                    .filter { it.apkUrl != null }
                    .filter { compareVersions(it.versionName, localVer) > 0 }
                    .maxWithOrNull(versionOrder)

                if (upgradeCandidate != null) {
                    val expectedSha256 = upgradeCandidate.expectedSha256
                        ?: return@withContext CheckResult.Error(
                            "Release ${upgradeCandidate.tagName} is missing the " +
                                (if (BuildConfig.POWER_FEATURES_ENABLED) "Power" else "Standard") +
                                " SHA-256 digest.",
                        )
                    AppLogger.info(
                        TAG,
                        "Update available: $localVer → ${upgradeCandidate.versionName} (${upgradeCandidate.tagName})",
                    )
                    return@withContext CheckResult.UpdateAvailable(
                        tagName = upgradeCandidate.tagName,
                        versionName = upgradeCandidate.versionName,
                        releaseName = upgradeCandidate.releaseName,
                        changelog = upgradeCandidate.changelog,
                        apkUrl = upgradeCandidate.apkUrl!!,
                        apkSizeBytes = upgradeCandidate.apkSize,
                        expectedSha256 = expectedSha256,
                    )
                }

                // No newer-with-APK candidate exists. Decide between three
                // remaining states:
                //   1. Highest release ≤ local version → UpToDate.
                //   2. Highest release > local but no APK in the listing →
                //      NoApkAsset (mention the tag so the user can grab the
                //      release manually if they really want).
                //   3. Otherwise (all releases ≤ local) → UpToDate as well.
                val highestVsLocal = compareVersions(highest.versionName, localVer)
                if (highestVsLocal > 0 && highest.apkUrl == null) {
                    AppLogger.info(
                        TAG,
                        "Release ${highest.tagName} > local but no APK asset",
                    )
                    return@withContext CheckResult.NoApkAsset(highest.tagName)
                }

                AppLogger.info(TAG, "Up to date: local=$localVer highest=${highest.versionName}")
                CheckResult.UpToDate
            }
        } catch (e: UnknownHostException) {
            AppLogger.error(TAG, "check failed: UnknownHostException: ${e.message}")
            CheckResult.NetworkUnreachable
        } catch (e: ConnectException) {
            AppLogger.error(TAG, "check failed: ConnectException: ${e.message}")
            CheckResult.NetworkUnreachable
        } catch (e: SocketTimeoutException) {
            AppLogger.error(TAG, "check failed: SocketTimeoutException: ${e.message}")
            CheckResult.NetworkUnreachable
        } catch (e: IOException) {
            // Catch-all for okhttp connection plumbing (e.g.
            // "failed to connect", SSL handshake errors). Most of these in
            // the CN-no-VPN scenario are effectively "can't reach github".
            AppLogger.error(TAG, "check failed: ${e.javaClass.simpleName}: ${e.message}")
            CheckResult.NetworkUnreachable
        } catch (e: Exception) {
            AppLogger.error(TAG, "check failed: ${e.javaClass.simpleName}: ${e.message}")
            CheckResult.Error(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Public so UI can deep-link users to manual download when GitHub is blocked. */
    const val RELEASES_URL: String = "https://github.com/leoyb1010/LeoPhoneAgent/releases"

    /**
     * Returns the APK for the installed capability edition. A Standard build
     * must never auto-install a Power APK (or vice versa), because the two
     * packages have different permission and review contracts. A single
     * generic APK remains supported for early releases that predate flavors.
     */
    private fun findApkAsset(assets: JSONArray?): Pair<String?, Long> {
        if (assets == null) return null to 0L
        val edition = if (BuildConfig.POWER_FEATURES_ENABLED) "power" else "standard"
        val editionToken = Regex("(^|[-_.])$edition([-_.]|$)")
        val generic = mutableListOf<Pair<String, Long>>()
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            val name = a.optString("name").lowercase()
            if (name.endsWith(".apk")) {
                val u = a.optString("browser_download_url").ifEmpty { null }
                if (u != null && editionToken.containsMatchIn(name)) {
                    return u to a.optLong("size", 0)
                }
                if (u != null && "power" !in name && "standard" !in name) {
                    generic += u to a.optLong("size", 0)
                }
            }
        }
        return generic.singleOrNull() ?: (null to 0L)
    }

    /**
     * Strip repository/flavor decoration while preserving prerelease sequence
     * components. `android-v1.0.0-alpha.25` and the Power build's
     * `1.0.0-alpha.24-power` must compare as 25 > 24.
     */
    internal fun normalizeTag(tag: String): String {
        val trimmed = tag.trim().removeSuffix("-power")
        val firstDigit = trimmed.indexOfFirst(Char::isDigit)
        return if (firstDigit >= 0) trimmed.substring(firstDigit) else trimmed.removePrefix("v").removePrefix("V")
    }

    /** Digest published in the GitHub Release body by the Android release gate. */
    internal fun releaseSha256(body: String, power: Boolean): String? {
        val edition = if (power) "Power" else "Standard"
        return Regex(
            "(?im)^\\s*${Regex.escape(edition)}\\s+SHA-256:\\s*([a-f0-9]{64})\\s*$",
        ).find(body)?.groupValues?.getOrNull(1)?.lowercase()
    }

    /**
     * Stream the APK from [url] into `${cacheDir}/shared/minis-update.apk`,
     * surfacing progress (0..1) through [onProgress] roughly every 64 KiB.
     * Returns the on-disk [File] on success so the caller can hand it to
     * [installApk]. The path is intentionally inside `shared/` because that's
     * the only sub-directory of cacheDir already exposed by FileProvider in
     * `file_provider_paths.xml`.
     */
    suspend fun download(
        context: Context,
        url: String,
        versionName: String? = null,
        expectedSha256: String? = null,
        onProgress: (Float) -> Unit = {},
    ): DownloadResult = withContext(Dispatchers.IO) {
        try {
            // Stage under filesDir (NOT cacheDir) so the OS doesn't evict
            // the APK mid-flow while the user is in system Settings granting
            // install permission — that eviction caused the "re-download
            // after grant" regression (T-android-update-resume-33637).
            val outDir = File(context.filesDir, UPDATES_DIR).apply { mkdirs() }
            // Filename keyed by version so a partial old-version download
            // can't accidentally satisfy a check for a newer version.
            val safeName = versionName
                ?.replace(Regex("[^A-Za-z0-9._-]"), "_")
                ?.takeIf { it.isNotEmpty() }
                ?.let { "minis-$it.apk" }
                ?: DOWNLOAD_FILENAME
            val outFile = File(outDir, safeName)
            // A previous, possibly-aborted download could leave a stale APK
            // behind that the installer would happily try to consume. Wipe it.
            if (outFile.exists()) outFile.delete()

            val req = Request.Builder().url(url).build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return@withContext DownloadResult.Error("HTTP ${resp.code}")
                }
                val body = resp.body ?: return@withContext DownloadResult.Error("empty body")
                val total = body.contentLength().takeIf { it > 0 } ?: -1L
                body.byteStream().use { input ->
                    outFile.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        var read: Int
                        var totalRead = 0L
                        var lastReported = -1
                        while (input.read(buf).also { read = it } != -1) {
                            output.write(buf, 0, read)
                            totalRead += read
                            if (total > 0) {
                                val pct = ((totalRead * 100) / total).toInt()
                                if (pct != lastReported) {
                                    lastReported = pct
                                    onProgress(pct / 100f)
                                }
                            }
                        }
                    }
                }
            }
            AppLogger.info(TAG, "Downloaded ${outFile.length()} bytes to ${outFile.absolutePath}")
            // Persist so a subsequent Activity recreate (e.g. after the user
            // returns from "install unknown apps" settings) can resume the
            // install without re-downloading. sha256 computed best-effort;
            // verify() falls back to size-only when null.
            val sha = runCatching { PendingUpdateStore.sha256(outFile) }
                .onFailure { AppLogger.warning(TAG, "sha256 compute failed: ${it.message}") }
                .getOrNull()
            if (expectedSha256 != null && !sha.equals(expectedSha256, ignoreCase = true)) {
                outFile.delete()
                return@withContext DownloadResult.Error("SHA-256 mismatch")
            }
            if (versionName != null) {
                PendingUpdateStore.setPending(
                    context,
                    PendingUpdateStore.PendingUpdate(
                        targetVersionName = versionName,
                        apkPath = outFile.absolutePath,
                        apkSize = outFile.length(),
                        sha256 = sha,
                        downloadedAtMs = System.currentTimeMillis(),
                    ),
                )
            }
            DownloadResult.Success(outFile)
        } catch (e: Exception) {
            AppLogger.error(TAG, "download failed: ${e.javaClass.simpleName}: ${e.message}")
            DownloadResult.Error(e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * Whether the OS will allow this app to launch a package-installer
     * intent. On Android 8+ the user must grant "install unknown apps" per
     * source-app; older releases inherit the system-wide setting.
     */
    fun canInstall(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }
    }

    /**
     * Send the user to the system "install unknown apps" preferences page
     * for this package. Caller should re-check [canInstall] after the user
     * returns.
     */
    fun openInstallPermissionSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    /**
     * Hand [apk] to the system package installer via FileProvider.
     * Caller must ensure [canInstall] before calling, otherwise the system
     * silently bounces back to the launcher. Returns false on any
     * launch failure so callers can surface an error instead of closing
     * the dialog with no visible feedback.
     */
    /**
     * If a pending APK from a previous download is still on disk and intact,
     * returns the [File]. The caller is responsible for checking
     * [canInstall] and firing [installApk]. Returns null when nothing pending
     * or when the cached file failed integrity checks — in the latter case
     * the pending record is cleared so the UI falls through to a fresh
     * download.
     */
    fun resumablePendingFile(context: Context): File? {
        val pending = PendingUpdateStore.getPending(context) ?: return null
        // Only resume if the persisted target is still newer than the running
        // build — protects against the case where the user updated by some
        // other means since the download.
        // [T-android-updatechecker-localver-normalize] targetVersionName is a
        // normalized version (set from upgradeCandidate.versionName), so the
        // local side must be normalized too — same asymmetry fix as check().
        if (compareVersions(pending.targetVersionName, normalizeTag(BuildConfig.VERSION_NAME)) <= 0) {
            AppLogger.info(TAG, "pending target ${pending.targetVersionName} <= local; clearing")
            PendingUpdateStore.clearPending(context)
            return null
        }
        val file = PendingUpdateStore.verify(pending)
        if (file == null) {
            AppLogger.info(TAG, "pending APK failed integrity; clearing")
            PendingUpdateStore.clearPending(context)
            return null
        }
        return file
    }

    fun installApk(context: Context, apk: File): Boolean {
        return try {
            if (!archiveMatchesInstalledApp(context, apk)) {
                AppLogger.error(TAG, "installApk rejected: package name or signer mismatch")
                return false
            }
            val authority = "${context.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(context, authority, apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            AppLogger.info(TAG, "installApk launched apk=${apk.absolutePath} size=${apk.length()}")
            // Once the installer is in flight we don't want a subsequent
            // resume to re-fire the intent (would double-prompt). Clear the
            // pending record now; if the user backs out, the next "Check for
            // Updates" tap will re-discover and re-download.
            PendingUpdateStore.clearPending(context)
            true
        } catch (e: Exception) {
            AppLogger.error(TAG, "installApk failed: ${e.javaClass.simpleName}: ${e.message}")
            false
        }
    }

    /** Never open the installer for an APK that cannot upgrade this exact app. */
    internal fun archiveMatchesInstalledApp(context: Context, apk: File): Boolean {
        val pm = context.packageManager
        val archive = packageInfo(pm, apk.absolutePath, archive = true) ?: return false
        val installed = packageInfo(pm, context.packageName, archive = false) ?: return false
        if (archive.packageName != context.packageName) return false
        val archiveSigners = signers(archive)
        val installedSigners = signers(installed)
        return archiveSigners.isNotEmpty() && archiveSigners.any { candidate ->
            installedSigners.any { current -> candidate.contentEquals(current) }
        }
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager, value: String, archive: Boolean): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return if (archive) pm.getPackageArchiveInfo(value, flags)
        else runCatching { pm.getPackageInfo(value, flags) }.getOrNull()
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): List<ByteArray> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signing = info.signingInfo ?: return emptyList()
            val values = if (signing.hasMultipleSigners()) signing.apkContentsSigners
            else signing.signingCertificateHistory
            return values.orEmpty().map { it.toByteArray() }
        }
        return info.signatures.orEmpty().map { it.toByteArray() }
    }

    /**
     * Numeric-aware version comparator. `1.0.10` beats `1.0.9`. Non-numeric
     * components fall back to lexicographic compare so a `1.0.0-rc1` build is
     * treated as "newer than 1.0.0" — acceptable noise for our use case.
     */
    internal fun compareVersions(a: String, b: String): Int {
        val ap = a.split('.', '-')
        val bp = b.split('.', '-')
        val n = maxOf(ap.size, bp.size)
        for (i in 0 until n) {
            val x = ap.getOrNull(i) ?: ""
            val y = bp.getOrNull(i) ?: ""
            val xi = x.toIntOrNull()
            val yi = y.toIntOrNull()
            val c = if (xi != null && yi != null) xi.compareTo(yi) else x.compareTo(y)
            if (c != 0) return c
        }
        return 0
    }
}
