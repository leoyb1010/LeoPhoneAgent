package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

/**
 * Executes shell commands inside the PRoot sandbox via ProcessBuilder.
 * Corresponds to iOS ISHShellExecutor.
 */
object ShellExecutor {

    private const val TAG = "ShellExecutor"
    private const val DEFAULT_TIMEOUT_MS = 600_000L // 10 minutes

    data class ShellResult(
        val output: String,
        val exitCode: Int,
        val durationMs: Long
    )

    /** The currently running process, if any. Can be destroyed to stop execution. */
    @Volatile
    var currentProcess: Process? = null
        private set

    /**
     * Execute a command inside the PRoot sandbox.
     *
     * @param context Android context for resolving PROOT_TMP_DIR
     * @param command Shell command string to execute
     * @param timeout Timeout in milliseconds (default 10 minutes)
     * @param environment Additional environment variables
     * @param lineCallback Called for each line of output (on IO dispatcher)
     * @return ShellResult with combined stdout+stderr, exit code, and duration
     */
    suspend fun execute(
        context: Context,
        command: String,
        timeout: Long = DEFAULT_TIMEOUT_MS,
        environment: Map<String, String> = emptyMap(),
        lineCallback: ((String) -> Unit)? = null
    ): ShellResult = withContext(Dispatchers.IO) {
        check(PRootKernel.isBooted) { "PRootKernel must be booted before executing commands" }

        val prootCommand = PRootKernel.buildProotCommand(command)

        Log.d(TAG, "Executing: $command")

        val startTime = System.currentTimeMillis()

        val processBuilder = ProcessBuilder(prootCommand)
        processBuilder.redirectErrorStream(true)

        // Set required environment for PRoot
        val env = processBuilder.environment()
        env["PROOT_TMP_DIR"] = PRootKernel.getProotTmpDir(context).absolutePath
        if (PRootKernel.nativeLibDir.isNotEmpty()) {
            env["LD_LIBRARY_PATH"] = PRootKernel.nativeLibDir
        }
        if (PRootKernel.prootLoaderPath.isNotEmpty()) {
            env["PROOT_LOADER"] = PRootKernel.prootLoaderPath
        }
        if (PRootKernel.prootLoader32Path.isNotEmpty()) {
            env["PROOT_LOADER_32"] = PRootKernel.prootLoader32Path
        }
        env["PROOT_VERBOSE"] = "-1"

        // Apply custom environment from PRootKernel
        for ((key, value) in PRootKernel.customEnvironment) {
            env[key] = value
        }

        // Apply per-call environment overrides
        for ((key, value) in environment) {
            env[key] = value
        }

        val rawOutput = StringBuilder()
        var exitCode = -1
        var readerThread: Thread? = null

        try {
            val process = processBuilder.start()
            currentProcess = process
            readerThread = Thread({
                try {
                    InputStreamReader(process.inputStream, StandardCharsets.UTF_8).use { reader ->
                        val buf = CharArray(4096)
                        val callbackLine = StringBuilder()
                        var suppressDiagnostics = false
                        var n: Int
                        while (reader.read(buf).also { n = it } != -1) {
                            synchronized(rawOutput) { rawOutput.append(buf, 0, n) }
                            if (lineCallback != null) {
                                for (i in 0 until n) {
                                    val c = buf[i]
                                    if (c == '\n') {
                                        val line = callbackLine.toString()
                                        callbackLine.clear()
                                        if (line.startsWith("talloc report on 'null_context'")) {
                                            suppressDiagnostics = true
                                        } else if (!suppressDiagnostics && !line.startsWith("proot info:")) {
                                            lineCallback.invoke(line)
                                        }
                                    } else if (c != '\r') {
                                        callbackLine.append(c)
                                    }
                                }
                            }
                        }
                        if (lineCallback != null && callbackLine.isNotEmpty() && !suppressDiagnostics) {
                            val line = callbackLine.toString()
                            if (!line.startsWith("proot info:")) lineCallback.invoke(line)
                        }
                    }
                } catch (_: Exception) {
                    // Stream closure is expected when a timed-out process is killed.
                }
            }, "ShellExecutor-reader").apply {
                isDaemon = true
                start()
            }

            if (process.waitFor(timeout, TimeUnit.MILLISECONDS)) {
                exitCode = process.exitValue()
            } else {
                Log.w(TAG, "Command timed out after ${timeout}ms: $command")
                process.destroyForcibly()
                // Do not block on waitFor after SIGKILL. Some PRoot workloads
                // keep inherited descriptors alive while the guest child is
                // being reaped, which previously stretched a 2s timeout past
                // 13s and could destabilize the instrumentation device.
                synchronized(rawOutput) {
                    rawOutput.appendLine("\n[Command timed out after ${timeout / 1000}s]")
                }
                exitCode = 124
            }
        } catch (e: Exception) {
            Log.e(TAG, "Command failed: $command", e)
            currentProcess?.destroyForcibly()
            synchronized(rawOutput) { rawOutput.appendLine("\n[Error: ${e.message}]") }
            exitCode = -1
        } finally {
            readerThread?.join(500)
            currentProcess = null
        }

        val output = cleanProotDiagnostics(synchronized(rawOutput) { rawOutput.toString() })
        val durationMs = System.currentTimeMillis() - startTime
        Log.d(TAG, "Command completed in ${durationMs}ms with exit code $exitCode")

        ShellResult(
            output = output.trimEnd(),
            exitCode = exitCode,
            durationMs = durationMs
        )
    }

    /** Removes PRoot implementation diagnostics that are not command output. */
    internal fun cleanProotDiagnostics(raw: String): String = raw
        .lineSequence()
        .takeWhile { !it.startsWith("talloc report on 'null_context'") }
        .filterNot { it.startsWith("proot info:") }
        .joinToString("\n")

    /**
     * Forcibly destroy the currently running process.
     */
    fun destroyCurrent() {
        currentProcess?.let { process ->
            Log.i(TAG, "Destroying current process")
            process.destroyForcibly()
            currentProcess = null
        }
    }
}
