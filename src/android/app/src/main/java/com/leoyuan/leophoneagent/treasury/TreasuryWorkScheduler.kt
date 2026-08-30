package com.leoyuan.leophoneagent.treasury

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.leoyuan.leophoneagent.MinisApp
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request

object TreasuryWorkScheduler {
    private const val UNIQUE_WORK = "treasury-enrichment"

    fun enqueue(context: Context) {
        val request = OneTimeWorkRequestBuilder<TreasuryEnrichmentWorker>()
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            UNIQUE_WORK,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request,
        )
    }
}

class TreasuryEnrichmentWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext as MinisApp
        val repository = app.treasureRepository
        repository.recoverInterruptedJobs()
        var processed = 0
        while (processed < 96) {
            val jobs = repository.readyJobs(limit = minOf(24, 96 - processed))
            if (jobs.isEmpty()) break
            for (job in jobs) {
                if (isStopped) return@withContext Result.retry()
                processed += 1
                if (!repository.claimJob(job.id)) continue
                val item = repository.get(listOf(job.itemId)).firstOrNull()
                if (item == null) {
                    repository.completeJob(job.id)
                    continue
                }
                if (job.jobType != "index") repository.markProcessing(item.id)
                try {
                    when (job.jobType) {
                        "metadata" -> enrichLink(item)
                        "extract_text" -> extractText(item)
                        "ocr" -> repository.markPartial(item.id, "ocr_engine_unavailable")
                        "transcribe" -> repository.markPartial(item.id, "transcription_not_authorized")
                        "index" -> repository.markIndexed(item.id)
                        else -> repository.markPartial(item.id, "unsupported_job")
                    }
                    repository.completeJob(job.id)
                } catch (error: RetryableTreasuryException) {
                    repository.failJob(job.id, error.code)
                    repository.markPartial(item.id, error.code)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Throwable) {
                    repository.failJob(job.id, "enhancement_failed")
                    repository.markProcessingFailed(item.id, "enhancement_failed")
                }
            }
        }
        val syncSucceeded = TreasurySyncClient(applicationContext).sync(repository)
        if (repository.hasPendingAutomaticJobs() || !syncSucceeded) Result.retry() else Result.success()
    }

    private suspend fun enrichLink(item: TreasureItemEntity) {
        val raw = item.sourceUri ?: return
        var current = URI(raw)
        try {
            for (redirectCount in 0..3) {
                val host = current.host ?: throw RetryableTreasuryException("unsafe_or_offline_url")
                val pinnedAddresses = publicAddresses(current)
                    ?: throw RetryableTreasuryException("unsafe_or_offline_url")
                val client = OkHttpClient.Builder()
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .readTimeout(7, TimeUnit.SECONDS)
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .dns(object : Dns {
                        override fun lookup(hostname: String): List<InetAddress> {
                            if (hostname.equals(host, ignoreCase = true)) return pinnedAddresses
                            throw UnknownHostException("Unexpected redirect host")
                        }
                    })
                    .build()
                val request = Request.Builder()
                    .url(current.toASCIIString())
                    .header("User-Agent", "LeoPhoneAgent-Treasury/1")
                    .header("Accept", "text/html,application/xhtml+xml")
                    .build()
                var redirect: URI? = null
                client.newCall(request).execute().use { response ->
                    val status = response.code
                    if (status in 300..399) {
                        if (redirectCount == 3) throw RetryableTreasuryException("too_many_redirects")
                        val location = response.header("Location")
                            ?: throw RetryableTreasuryException("redirect_without_location")
                        redirect = current.resolve(location)
                        return@use
                    }
                    if (status !in 200..299) throw RetryableTreasuryException("http_$status")
                    val type = response.header("Content-Type").orEmpty().lowercase(Locale.ROOT)
                    if (!type.contains("html")) {
                        (applicationContext as MinisApp).treasureRepository.applyEnhancement(item.id, state = "ready")
                        return
                    }
                    val inputBody = response.body ?: throw RetryableTreasuryException("empty_response")
                    val bytes = inputBody.byteStream().use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (output.size() < 1_000_000) {
                            val count = input.read(buffer, 0, minOf(buffer.size, 1_000_000 - output.size()))
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                    val html = bytes.toString(Charsets.UTF_8)
                    val title = Regex("<title[^>]*>(.*?)</title>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
                        .find(html)?.groupValues?.getOrNull(1)
                        ?.replace(Regex("\\s+"), " ")?.trim()?.take(500)
                    val text = android.text.Html.fromHtml(html, android.text.Html.FROM_HTML_MODE_LEGACY)
                        .toString().replace(Regex("[\\t\\r ]+"), " ")
                        .replace(Regex("\\n{3,}"), "\n\n").trim().take(2_000_000)
                    (applicationContext as MinisApp).treasureRepository.applyEnhancement(
                        item.id,
                        title = title,
                        capturedTitle = item.title,
                        originalText = text.takeIf(String::isNotBlank),
                        state = "ready",
                    )
                    return
                }
                current = redirect ?: throw RetryableTreasuryException("redirect_failed")
            }
        } catch (error: java.io.IOException) {
            throw RetryableTreasuryException("network_unavailable", error)
        }
    }

    private suspend fun extractText(item: TreasureItemEntity) {
        val mime = item.mimeType.orEmpty().lowercase(Locale.ROOT)
        val file = resolveBodyFile(item) ?: run {
            (applicationContext as MinisApp).treasureRepository.markProcessingFailed(item.id, "attachment_missing")
            return
        }
        if (mime == "application/pdf" || file.extension.equals("pdf", ignoreCase = true)) {
            extractPdf(item, file)
            return
        }
        if (!(mime.startsWith("text/") || mime.contains("json") || mime.contains("xml") || mime.contains("markdown"))) {
            (applicationContext as MinisApp).treasureRepository.markPartial(item.id, "text_extractor_unavailable")
            return
        }
        val text = TreasuryFilePolicy.readUtf8TextLimited(file, 2_000_000)
        (applicationContext as MinisApp).treasureRepository.applyEnhancement(item.id, originalText = text, state = "ready")
    }

    private suspend fun extractPdf(item: TreasureItemEntity, file: File) {
        PDFBoxResourceLoader.init(applicationContext)
        val pages = mutableListOf<String>()
        PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly()).use { document ->
            val count = minOf(document.numberOfPages, 500)
            val stripper = PDFTextStripper()
            for (page in 1..count) {
                stripper.startPage = page
                stripper.endPage = page
                pages += stripper.getText(document).trim()
                if (pages.sumOf(String::length) >= 2_000_000) break
            }
        }
        if (!(applicationContext as MinisApp).treasureRepository.applyDocumentExtraction(item.id, pages)) {
            (applicationContext as MinisApp).treasureRepository.markPartial(item.id, "pdf_text_unavailable")
        }
    }

    private fun resolveBodyFile(item: TreasureItemEntity): File? {
        val ref = item.bodyRef ?: return null
        if (!com.leoyuan.leophoneagent.data.repository.TreasureRepository.isSafeRelativeRef(ref)) return null
        val root = File(applicationContext.filesDir, "treasury").canonicalFile
        val file = File(root, ref).canonicalFile
        return file.takeIf { it.path.startsWith(root.path + File.separator) && it.isFile }
    }

    private fun publicAddresses(uri: URI): List<InetAddress>? {
        if (uri.scheme?.lowercase(Locale.ROOT) !in setOf("http", "https") || uri.host.isNullOrBlank()) return null
        val addresses = runCatching { InetAddress.getAllByName(uri.host) }.getOrNull() ?: return null
        val safe = addresses.isNotEmpty() && addresses.all(TreasuryNetworkPolicy::isPublicAddress)
        return addresses.toList().takeIf { safe }
    }

    private class RetryableTreasuryException(
        val code: String,
        cause: Throwable? = null,
    ) : Exception(code, cause)
}

internal object TreasuryNetworkPolicy {
    fun isPublicAddress(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress) return false
        val bytes = address.address.map(Byte::toInt).map { it and 0xFF }
        if (bytes.size == 4) {
            val a = bytes[0]
            val b = bytes[1]
            val c = bytes[2]
            return when {
                a == 0 || a == 10 || a == 127 || a >= 224 -> false
                a == 100 && b in 64..127 -> false
                a == 169 && b == 254 -> false
                a == 172 && b in 16..31 -> false
                a == 192 && b == 168 -> false
                a == 192 && b == 0 && c in 0..2 -> false
                a == 198 && b in 18..19 -> false
                a == 198 && b == 51 && c == 100 -> false
                a == 203 && b == 0 && c == 113 -> false
                else -> true
            }
        }
        if (bytes.size == 16) {
            val uniqueLocal = (bytes[0] and 0xFE) == 0xFC
            val documentation = bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0D && bytes[3] == 0xB8
            return !uniqueLocal && !documentation
        }
        return false
    }
}
