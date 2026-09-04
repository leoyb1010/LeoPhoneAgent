package com.leoyuan.leophoneagent.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.TextSnippet
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Long pasted content held outside the editor until send time. */
data class PastedText(val id: Int, val text: String) {
    val placeholder: String get() = placeholderFor(id)
    companion object { fun placeholderFor(id: Int): String = "[Pasted#$id]" }
}

private val placeholderRegex = Regex("""\[[Pp]asted#(\d+)]""")

/** Beyond this size, a paste is handled as a normal text-file attachment. */
const val PASTE_AS_FILE_THRESHOLD = 15_000

/** Expands known placeholders in one pass; unknown or edited markers stay literal. */
fun expandPastePlaceholders(text: String, buffer: List<PastedText>): Pair<String, Set<Int>> {
    if (text.isEmpty() || buffer.isEmpty()) return text to emptySet()
    val byId = buffer.associateBy { it.id }
    val used = mutableSetOf<Int>()
    val result = StringBuilder(text.length)
    var cursor = 0
    placeholderRegex.findAll(text).forEach { match ->
        val item = match.groupValues[1].toIntOrNull()?.let(byId::get) ?: return@forEach
        result.append(text, cursor, match.range.first)
        result.append(item.text)
        cursor = match.range.last + 1
        used += item.id
    }
    if (used.isEmpty()) return text to emptySet()
    result.append(text, cursor, text.length)
    return result.toString() to used
}

/** Mirrors iOS: >1000 English words or >1200 non-English-dominant characters. */
fun isLongPastedText(inserted: String): Boolean {
    val asciiLetters = inserted.count { it in 'A'..'Z' || it in 'a'..'z' }
    return if (asciiLetters > inserted.length / 2) {
        inserted.split(' ', '\n', '\t', '\r').count(String::isNotEmpty) > 1000
    } else {
        inserted.length > 1200
    }
}

/** Replaces one large inserted span with a compact placeholder at the same caret. */
fun foldLongPasteIfNeeded(
    old: TextFieldValue,
    new: TextFieldValue,
    stash: (String) -> String,
): TextFieldValue {
    if (new.text.length <= old.text.length) return new
    var prefix = 0
    while (prefix < minOf(old.text.length, new.text.length) && old.text[prefix] == new.text[prefix]) prefix++
    var suffix = 0
    val maxSuffix = minOf(old.text.length - prefix, new.text.length - prefix)
    while (suffix < maxSuffix && old.text[old.text.lastIndex - suffix] == new.text[new.text.lastIndex - suffix]) suffix++
    val end = new.text.length - suffix
    if (end <= prefix) return new
    val inserted = new.text.substring(prefix, end)
    if (!isLongPastedText(inserted)) return new
    val marker = stash(inserted)
    val folded = new.text.substring(0, prefix) + marker + new.text.substring(end)
    return TextFieldValue(folded, TextRange(prefix + marker.length))
}

/** Compact attachment-style tile for folded paste state. */
@Composable
fun PastedTextChip(pasted: PastedText, onRemove: () -> Unit) {
    Box(modifier = Modifier.size(width = 72.dp, height = 70.dp)) {
        Column(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .size(64.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
                .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp)),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.TextSnippet,
                contentDescription = null,
                modifier = Modifier.size(28.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Text("#${pasted.id}", fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Text("${pasted.text.length} 字", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(
            onClick = onRemove,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(24.dp)
                .background(MaterialTheme.colorScheme.surface, CircleShape),
        ) {
            Icon(Icons.Default.Close, contentDescription = "Remove pasted text", modifier = Modifier.size(14.dp))
        }
    }
}
