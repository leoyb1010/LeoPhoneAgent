package com.leoyuan.leophoneagent.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.AudioFile
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.VideoFile
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.leoyuan.leophoneagent.R
import org.json.JSONObject

internal data class ChatArtifact(
    val path: String,
    val fileName: String,
    val extension: String,
)

/**
 * Promotes a successful file_write into a first-class chat artifact.
 *
 * Keep the boundary deliberately narrow: only files with a useful in-app
 * preview become cards. Source/config files remain available in the normal
 * tool detail without turning every agent edit into visual noise.
 */
internal fun artifactFromToolBlock(block: AssistantBlock): ChatArtifact? {
    if (block.toolName != "file_write" || block.toolStatus != ToolBlockStatus.SUCCESS) return null
    val path = runCatching { JSONObject(block.toolArgs).optString("path").trim() }
        .getOrDefault("")
    if (path.isEmpty() || path.contains('\u0000')) return null
    val segments = path.split('/')
    if (segments.any { it == ".." }) return null
    if (ARTIFACT_ROOTS.none { root -> path.startsWith(root) }) return null
    val fileName = path.substringAfterLast('/').takeIf { it.isNotBlank() } ?: return null
    val extension = fileName.substringAfterLast('.', "").lowercase()
    if (extension !in PREVIEWABLE_ARTIFACT_EXTENSIONS) return null
    return ChatArtifact(path = path, fileName = fileName, extension = extension)
}

private val PREVIEWABLE_ARTIFACT_EXTENSIONS = setOf(
    "html", "htm", "md", "markdown", "svg", "csv", "tsv", "pdf",
    "png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov",
    "mp3", "m4a", "wav", "ogg",
)

private val ARTIFACT_ROOTS = listOf(
    "/var/minis/workspace/",
    "/var/minis/attachments/",
    "/var/minis/shared/",
    "/var/minis/mounts/",
)

private data class ArtifactVisual(
    val icon: ImageVector,
    val labelRes: Int,
    val accent: Color,
)

@Composable
private fun artifactVisual(extension: String): ArtifactVisual = when (extension) {
    "html", "htm" -> ArtifactVisual(Icons.Default.Code, R.string.artifact_type_web, Color(0xFF7C3AED))
    "md", "markdown" -> ArtifactVisual(Icons.AutoMirrored.Filled.Article, R.string.artifact_type_document, Color(0xFF2563EB))
    "svg" -> ArtifactVisual(Icons.Default.DataObject, R.string.artifact_type_vector, Color(0xFFDB2777))
    "csv", "tsv" -> ArtifactVisual(Icons.Default.TableChart, R.string.artifact_type_table, Color(0xFF059669))
    "pdf" -> ArtifactVisual(Icons.Default.PictureAsPdf, R.string.artifact_type_pdf, Color(0xFFDC2626))
    "png", "jpg", "jpeg", "webp", "gif" -> ArtifactVisual(Icons.Default.Image, R.string.artifact_type_image, Color(0xFF0D9488))
    "mp4", "webm", "mov" -> ArtifactVisual(Icons.Default.VideoFile, R.string.artifact_type_video, Color(0xFFEA580C))
    "mp3", "m4a", "wav", "ogg" -> ArtifactVisual(Icons.Default.AudioFile, R.string.artifact_type_audio, Color(0xFF9333EA))
    else -> ArtifactVisual(Icons.AutoMirrored.Filled.InsertDriveFile, R.string.artifact_type_file, MaterialTheme.colorScheme.primary)
}

@Composable
internal fun ArtifactCard(
    artifact: ChatArtifact,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val visual = artifactVisual(artifact.extension)
    val openLabel = stringResource(R.string.artifact_open)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 5.dp, bottom = 7.dp)
            .border(1.dp, visual.accent.copy(alpha = 0.18f), RoundedCornerShape(18.dp))
            .background(visual.accent.copy(alpha = 0.07f), RoundedCornerShape(18.dp))
            .clickable(
                onClickLabel = openLabel,
                onClick = onOpen,
            )
            .heightIn(min = 72.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .background(visual.accent.copy(alpha = 0.13f), RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = visual.icon,
                contentDescription = null,
                tint = visual.accent,
                modifier = Modifier.size(22.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = stringResource(R.string.artifact_ready),
                color = visual.accent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = artifact.fileName,
                color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(visual.labelRes),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Spacer(Modifier.width(10.dp))
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = openLabel,
            tint = visual.accent,
            modifier = Modifier.size(20.dp),
        )
    }
}
