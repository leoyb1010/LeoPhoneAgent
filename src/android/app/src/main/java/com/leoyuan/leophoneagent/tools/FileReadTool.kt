package com.leoyuan.leophoneagent.tools

import android.content.Context
import com.leoyuan.leophoneagent.data.model.AgentToolDefinition
import com.leoyuan.leophoneagent.data.model.AgentToolParam
import com.leoyuan.leophoneagent.sandbox.PRootKernel
import org.json.JSONObject
import java.io.File

object FileReadTool {
    const val NAME = "file_read"

    fun definition(): AgentToolDefinition = AgentToolDefinition(
        name = NAME,
        description = "Read a file from the Linux filesystem. Faster than shell_execute for reading files — no shell overhead. Returns file content with metadata. Rejects binary files. Head pages that still have unread lines append `next_offset` for the next call.",
        parameters = mapOf(
            "tool_title" to AgentToolParam("string", "A concise 5-10 word summary of what this tool call does, shown to the user (e.g. 'Read Python script contents', 'Check system configuration file'). Use the same language as the user."),
            "path" to AgentToolParam("string", "Absolute Linux path to read (e.g. /var/minis/workspace/data.csv)"),
            "offset" to AgentToolParam("integer", "1-based line number to start reading from (default: 1). Ignored when direction is 'tail'."),
            "lines" to AgentToolParam("integer", "Maximum number of lines to return (default: all lines up to max_length)"),
            "max_length" to AgentToolParam("integer", "Maximum character length of returned content (default: 15000)"),
            "direction" to AgentToolParam("string", "Read direction: 'head' (from start, default) or 'tail' (from end of file)"),
        ),
        required = listOf("tool_title", "path"),
        propertyOrdering = listOf("tool_title", "path", "offset", "lines", "direction", "max_length"),
    )

    fun execute(argsJson: String, sessionId: String, context: Context): ToolExecutionResult {
        return try {
            val args = JSONObject(argsJson)
            val path = args.optString("path", "")
            val toolTitle = args.optString("tool_title", NAME)
            val offset = args.optInt("offset", 1).coerceAtLeast(1)
            val maxLength = args.optInt("max_length", FileReadPaging.DEFAULT_MAX_LENGTH)
            val direction = args.optString("direction", "head")

            if (path.isBlank()) {
                return ToolExecutionResult("Error: 'path' is required", false, toolTitle = toolTitle)
            }

            // T123: per-session resolver — see FileWriteTool for rationale.
            val file = PRootKernel.resolveSessionHostPath(sessionId, path, context)
                ?: return ToolExecutionResult("Error: Cannot resolve path: $path", false, toolTitle = toolTitle)

            if (!file.exists()) {
                return ToolExecutionResult("Error: File not found: $path", false, toolTitle = toolTitle)
            }

            if (file.isDirectory) {
                return ToolExecutionResult("Error: Path is a directory: $path", false, toolTitle = toolTitle)
            }

            val size = file.length()

            // Binary detection: check first 8192 bytes for null bytes
            val isBinary = file.inputStream().use { input ->
                val buf = ByteArray(minOf(8192, size.toInt()))
                val read = input.read(buf)
                if (read > 0) buf.take(read).any { it == 0.toByte() } else false
            }

            if (isBinary) {
                return ToolExecutionResult(
                    "[$path | $size bytes | binary file — cannot display contents]",
                    true, toolTitle = toolTitle
                )
            }

            val allLines = file.readLines()
            val requestedLines = if (args.has("lines")) args.optInt("lines") else null
            val page = FileReadPaging.page(allLines, offset, requestedLines, maxLength, direction)
            ToolExecutionResult(FileReadPaging.formatOutput(path, size, page), true, toolTitle = toolTitle)
        } catch (e: Exception) {
            ToolExecutionResult("Error reading file: ${e.message}", false)
        }
    }
}
