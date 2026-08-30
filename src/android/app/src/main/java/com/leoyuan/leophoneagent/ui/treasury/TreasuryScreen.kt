package com.leoyuan.leophoneagent.ui.treasury

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.data.db.TreasureHighlightEntity
import com.leoyuan.leophoneagent.data.db.TreasureSearchRow
import com.leoyuan.leophoneagent.data.repository.TreasureRepository
import com.leoyuan.leophoneagent.treasury.TreasuryWorkScheduler
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.io.File

private enum class TreasuryFilter { INBOX, PROCESSING, FAILED, UNREAD, RECENT, ALL, LINKS, NOTES, FILES }
private const val TREASURY_READER_MAX_CHARS = 200_000

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TreasuryScreen(
    repository: TreasureRepository,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var filterName by rememberSaveable { mutableStateOf(TreasuryFilter.INBOX.name) }
    val filter = runCatching { TreasuryFilter.valueOf(filterName) }.getOrDefault(TreasuryFilter.ALL)
    var selectedItemId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedIdsList by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val selectedIds = remember(selectedIdsList) { selectedIdsList.toSet() }
    var rows by remember { mutableStateOf(emptyList<TreasureSearchRow>()) }
    var selected by remember { mutableStateOf<TreasureItemEntity?>(null) }
    var highlights by remember { mutableStateOf(emptyList<TreasureHighlightEntity>()) }
    var annotationDraft by rememberSaveable(selectedItemId) { mutableStateOf("") }
    var showCapture by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            com.leoyuan.leophoneagent.treasury.TreasuryCaptureService.captureUris(context, uris)
        }
    }

    LaunchedEffect(query) {
        delay(220)
        repository.search(query, limit = 500).collectLatest { rows = it }
    }

    LaunchedEffect(selectedItemId) {
        val id = selectedItemId
        if (id == null) {
            selected = null
            highlights = emptyList()
            return@LaunchedEffect
        }
        selected = repository.markOpened(id)
        if (annotationDraft.isEmpty()) annotationDraft = selected?.annotation.orEmpty()
        repository.observeHighlights(id).collectLatest { highlights = it }
    }

    val visible = remember(rows, filter) {
        val filtered = rows.filter { item ->
            !item.archived && when (filter) {
                TreasuryFilter.INBOX -> item.lastOpenedAt == null
                TreasuryFilter.PROCESSING -> item.processingState in setOf("saved", "queued", "processing")
                TreasuryFilter.FAILED -> item.processingState in setOf("partial", "failed")
                TreasuryFilter.UNREAD -> item.readingState == "unread"
                TreasuryFilter.RECENT -> item.lastOpenedAt != null
                TreasuryFilter.ALL -> true
                TreasuryFilter.LINKS -> item.kind == "link"
                TreasuryFilter.NOTES -> item.kind in setOf("text", "note", "artifact")
                TreasuryFilter.FILES -> item.kind in setOf("image", "document", "audio", "video")
            }
        }
        if (filter == TreasuryFilter.RECENT) filtered.sortedByDescending { it.lastOpenedAt } else filtered
    }
    val selectedItem = selected
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 600.dp
        val extraWide = maxWidth >= 840.dp
        if (!wide && selectedItem != null) {
            BackHandler { selectedItemId = null }
            TreasuryDetail(
                item = selectedItem,
                annotationDraft = annotationDraft.ifEmpty { selectedItem.annotation.orEmpty() },
                onAnnotationChanged = { annotationDraft = it },
                onSaveAnnotation = {
                    scope.launch {
                        selected = repository.updateItem(selectedItem.id, annotation = annotationDraft)
                    }
                },
                highlights = highlights,
                onProgress = { progress ->
                    scope.launch { selected = repository.updateReadingProgress(selectedItem.id, progress) }
                },
                onReadingState = { state ->
                    scope.launch { selected = repository.updateItem(selectedItem.id, readingState = state) }
                },
                onAddHighlight = { start, end, quote, note ->
                    scope.launch { repository.addHighlight(selectedItem.id, start, end, quote, note) }
                },
                onDeleteHighlight = { id -> scope.launch { repository.deleteHighlight(id) } },
                onRetry = {
                    scope.launch {
                        repository.retryFailedJobs(selectedItem.id)
                        TreasuryWorkScheduler.enqueue(context)
                    }
                },
                onBack = { selectedItemId = null },
            )
        } else {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text(stringResource(R.string.treasury_title), fontWeight = FontWeight.Bold) },
                        navigationIcon = {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.settings_back))
                            }
                        },
                        actions = {
                            if (selectedIds.isNotEmpty()) {
                                IconButton(onClick = {
                                    scope.launch {
                                        selectedIds.forEach { repository.updateItem(it, pinned = true) }
                                        selectedIdsList = emptyList()
                                    }
                                }) { Icon(Icons.Default.PushPin, stringResource(R.string.treasury_pin_selected)) }
                                IconButton(onClick = {
                                    scope.launch {
                                        selectedIds.forEach { repository.updateItem(it, archived = true) }
                                        selectedIdsList = emptyList()
                                    }
                                }) { Icon(Icons.Default.Archive, stringResource(R.string.treasury_archive_selected)) }
                                IconButton(onClick = { selectedIdsList = emptyList() }) {
                                    Icon(Icons.Default.Close, stringResource(R.string.cancel))
                                }
                            } else {
                                IconButton(onClick = { filePicker.launch(arrayOf("*/*")) }) {
                                    Icon(Icons.Default.AttachFile, stringResource(R.string.treasury_import_files))
                                }
                                IconButton(onClick = { showCapture = true }) {
                                    Icon(Icons.Default.Bookmark, stringResource(R.string.treasury_add))
                                }
                            }
                        },
                    )
                },
            ) { padding ->
                Row(Modifier.fillMaxSize().padding(padding)) {
                    if (extraWide) {
                        TreasuryFilterRail(
                            filter = filter,
                            onFilter = { filterName = it.name },
                            modifier = Modifier.width(190.dp).fillMaxHeight(),
                        )
                        VerticalDivider(Modifier.fillMaxHeight())
                    }
                    TreasuryList(
                        rows = visible,
                        query = query,
                        onQuery = { query = it },
                        filter = filter,
                        showInlineFilters = !extraWide,
                        onFilter = { filterName = it.name },
                        selectedIds = selectedIds,
                        onToggleSelection = { id ->
                            selectedIdsList = if (id in selectedIds) selectedIdsList - id else selectedIdsList + id
                        },
                        onOpen = { item ->
                            selectedItemId = item.id
                        },
                        listState = listState,
                        modifier = if (wide) Modifier.width(380.dp).fillMaxHeight() else Modifier.fillMaxSize(),
                    )
                    if (wide) {
                        VerticalDivider(Modifier.fillMaxHeight())
                        if (selectedItem != null) {
                            TreasuryDetail(
                                item = selectedItem,
                                annotationDraft = annotationDraft,
                                onAnnotationChanged = { annotationDraft = it },
                                onSaveAnnotation = {
                                    scope.launch {
                                        selected = repository.updateItem(selectedItem.id, annotation = annotationDraft)
                                    }
                                },
                                highlights = highlights,
                                onProgress = { progress ->
                                    scope.launch { selected = repository.updateReadingProgress(selectedItem.id, progress) }
                                },
                                onReadingState = { state ->
                                    scope.launch { selected = repository.updateItem(selectedItem.id, readingState = state) }
                                },
                                onAddHighlight = { start, end, quote, note ->
                                    scope.launch { repository.addHighlight(selectedItem.id, start, end, quote, note) }
                                },
                                onDeleteHighlight = { id -> scope.launch { repository.deleteHighlight(id) } },
                                onRetry = {
                                    scope.launch {
                                        repository.retryFailedJobs(selectedItem.id)
                                        TreasuryWorkScheduler.enqueue(context)
                                    }
                                },
                                onBack = null,
                                modifier = Modifier.weight(1f),
                            )
                        } else {
                            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.Center) {
                                Text(stringResource(R.string.treasury_select_item), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCapture) {
        TreasuryCaptureDialog(
            onDismiss = { showCapture = false },
            onCapture = { value ->
                showCapture = false
                scope.launch {
                    com.leoyuan.leophoneagent.treasury.TreasuryCaptureService.captureTextOrUrl(context, value)
                }
            },
        )
    }
}

@Composable
private fun TreasuryList(
    rows: List<TreasureSearchRow>,
    query: String,
    onQuery: (String) -> Unit,
    filter: TreasuryFilter,
    showInlineFilters: Boolean,
    onFilter: (TreasuryFilter) -> Unit,
    selectedIds: Set<String>,
    onToggleSelection: (String) -> Unit,
    onOpen: (TreasureSearchRow) -> Unit,
    listState: LazyListState,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            leadingIcon = { Icon(Icons.Default.Search, null) },
            placeholder = { Text(stringResource(R.string.treasury_search_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        )
        if (showInlineFilters) {
            FlowRow(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TreasuryFilter.entries.forEach { choice ->
                    FilterChip(
                        selected = filter == choice,
                        onClick = { onFilter(choice) },
                        label = { Text(filterLabel(choice)) },
                    )
                }
            }
        }
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.treasury_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                items(rows, key = { it.id }) { item ->
                    TreasuryRow(
                        item = item,
                        selected = item.id in selectedIds,
                        onSelect = { onToggleSelection(item.id) },
                        onOpen = { onOpen(item) },
                    )
                }
            }
        }
    }
}

@Composable
private fun TreasuryRow(
    item: TreasureSearchRow,
    selected: Boolean,
    onSelect: () -> Unit,
    onOpen: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(kindIcon(item.kind), null, modifier = Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f).padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                item.title?.takeIf(String::isNotBlank) ?: item.sourceLabel,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                item.snippet,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(item.sourceLabel, style = MaterialTheme.typography.labelSmall)
                if (item.processingState in setOf("partial", "failed")) {
                    Icon(Icons.Default.ErrorOutline, null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.error)
                    Text(processingLabel(item.processingState), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
        Checkbox(checked = selected, onCheckedChange = { onSelect() })
    }
    HorizontalDivider()
}

@Composable
private fun TreasuryFilterRail(filter: TreasuryFilter, onFilter: (TreasuryFilter) -> Unit, modifier: Modifier) {
    Column(modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.treasury_views), style = MaterialTheme.typography.titleSmall)
        TreasuryFilter.entries.forEach { choice ->
            FilterChip(
                selected = filter == choice,
                onClick = { onFilter(choice) },
                label = { Text(filterLabel(choice)) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TreasuryDetail(
    item: TreasureItemEntity,
    annotationDraft: String,
    onAnnotationChanged: (String) -> Unit,
    onSaveAnnotation: () -> Unit,
    highlights: List<TreasureHighlightEntity>,
    onProgress: (Double) -> Unit,
    onReadingState: (String) -> Unit,
    onAddHighlight: (Int, Int, String, String?) -> Unit,
    onDeleteHighlight: (String) -> Unit,
    onRetry: () -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var progressDraft by remember(item.id, item.readingProgress) { mutableStateOf(item.readingProgress.toFloat()) }
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(item.title ?: item.sourceLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.settings_back))
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TreasuryLabel(item.sourceLabel)
                    TreasuryLabel(processingLabel(item.processingState))
                }
            }
            item.sourceUri?.let { url ->
                item {
                    OutlinedButton(onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
                    }) { Icon(Icons.Default.Link, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.treasury_open_source)) }
                }
            }
            val fullBody = item.originalText ?: item.summary
            val body = fullBody?.take(TREASURY_READER_MAX_CHARS)
            if (!body.isNullOrBlank()) {
                item {
                    Text(stringResource(R.string.treasury_content), style = MaterialTheme.typography.titleMedium)
                    TreasurySelectableBody(
                        body = body,
                        highlights = highlights,
                        onAddHighlight = onAddHighlight,
                        onDeleteHighlight = onDeleteHighlight,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                    if ((fullBody?.length ?: 0) > TREASURY_READER_MAX_CHARS) {
                        Text(
                            stringResource(R.string.treasury_body_truncated),
                            modifier = Modifier.padding(top = 8.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (item.bodyRef != null && body.isNullOrBlank()) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(stringResource(R.string.treasury_attachment_saved, item.mimeType ?: "file", item.byteCount))
                            OutlinedButton(onClick = { openTreasuryAttachment(context, item) }) {
                                Icon(Icons.Default.Description, null)
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.treasury_open_attachment))
                            }
                        }
                    }
                }
            }
            item {
                Text(stringResource(R.string.treasury_reading_progress), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.treasury_reading_percent, (progressDraft * 100).toInt()))
                Slider(
                    value = progressDraft,
                    onValueChange = { progressDraft = it },
                    onValueChangeFinished = { onProgress(progressDraft.toDouble()) },
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("unread", "reading", "read").forEach { state ->
                        FilterChip(
                            selected = item.readingState == state,
                            onClick = { onReadingState(state) },
                            label = { Text(readingStateLabel(state)) },
                        )
                    }
                }
            }
            item {
                Text(stringResource(R.string.treasury_annotation), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = annotationDraft,
                    onValueChange = { onAnnotationChanged(it.take(20_000)) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                )
                Button(onClick = onSaveAnnotation, modifier = Modifier.padding(top = 8.dp)) {
                    Icon(Icons.Default.Check, null)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.save))
                }
            }
            if (item.processingState in setOf("partial", "failed")) {
                item {
                    Text(
                        processingErrorLabel(item.processingErrorCode),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (item.processingErrorCode !in nonRetryableProcessingErrors) {
                        OutlinedButton(onClick = onRetry, modifier = Modifier.padding(top = 8.dp)) {
                            Icon(Icons.Default.Refresh, null)
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.treasury_retry_processing))
                        }
                    }
                }
            }
            item { Spacer(Modifier.size(24.dp)) }
        }
    }
}

@Composable
private fun TreasuryLabel(value: String) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Text(value, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
    }
}

private fun openTreasuryAttachment(context: android.content.Context, item: TreasureItemEntity) {
    val ref = item.bodyRef ?: return
    if (!TreasureRepository.isSafeRelativeRef(ref)) return
    runCatching {
        val root = File(context.filesDir, "treasury").canonicalFile
        val file = File(root, ref).canonicalFile
        require(file.path.startsWith(root.path + File.separator) && file.isFile)
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        context.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, item.mimeType ?: "application/octet-stream")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        })
    }
}

@Composable
private fun TreasuryCaptureDialog(onDismiss: () -> Unit, onCapture: (String) -> Unit) {
    var value by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.treasury_capture_url_title)) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                placeholder = { Text("https://") },
                minLines = 3,
                maxLines = 8,
            )
        },
        confirmButton = {
            Button(onClick = { onCapture(value.trim()) }, enabled = value.isNotBlank()) {
                Text(stringResource(R.string.treasury_save_action))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun filterLabel(filter: TreasuryFilter): String = when (filter) {
    TreasuryFilter.INBOX -> stringResource(R.string.treasury_filter_inbox)
    TreasuryFilter.PROCESSING -> stringResource(R.string.treasury_filter_processing)
    TreasuryFilter.UNREAD -> stringResource(R.string.treasury_filter_unread)
    TreasuryFilter.RECENT -> stringResource(R.string.treasury_filter_recent)
    TreasuryFilter.ALL -> stringResource(R.string.treasury_filter_all)
    TreasuryFilter.LINKS -> stringResource(R.string.treasury_filter_links)
    TreasuryFilter.NOTES -> stringResource(R.string.treasury_filter_notes)
    TreasuryFilter.FILES -> stringResource(R.string.treasury_filter_files)
    TreasuryFilter.FAILED -> stringResource(R.string.treasury_filter_failed)
}

@Composable
private fun readingStateLabel(state: String): String = when (state) {
    "unread" -> stringResource(R.string.treasury_reading_unread)
    "reading" -> stringResource(R.string.treasury_reading_reading)
    "read" -> stringResource(R.string.treasury_reading_read)
    else -> state
}

@Composable
private fun TreasurySelectableBody(
    body: String,
    highlights: List<TreasureHighlightEntity>,
    onAddHighlight: (Int, Int, String, String?) -> Unit,
    onDeleteHighlight: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var value by remember(body) { mutableStateOf(TextFieldValue(body)) }
    var note by rememberSaveable(body.hashCode()) { mutableStateOf("") }
    val range = value.selection
    val hasSelection = !range.collapsed && range.min >= 0 && range.max <= body.length
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextField(
            value = value,
            onValueChange = { value = it.copy(text = body) },
            readOnly = true,
            modifier = Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.treasury_select_highlight_hint)) },
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(20_000) },
            label = { Text(stringResource(R.string.treasury_highlight_note)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        Button(
            enabled = hasSelection,
            onClick = {
                if (!hasSelection) return@Button
                onAddHighlight(range.min, range.max, body.substring(range.min, range.max), note.trim().ifEmpty { null })
                value = value.copy(selection = androidx.compose.ui.text.TextRange(range.max))
                note = ""
            },
        ) { Text(stringResource(R.string.treasury_save_highlight)) }
        if (highlights.isNotEmpty()) {
            Text(stringResource(R.string.treasury_saved_highlights), style = MaterialTheme.typography.titleSmall)
            highlights.forEach { highlight ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("“${highlight.quoteText}”")
                        highlight.note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        TextButton(onClick = { onDeleteHighlight(highlight.id) }) {
                            Text(stringResource(R.string.treasury_delete_highlight))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun processingLabel(state: String): String = when (state) {
    "saved" -> stringResource(R.string.treasury_state_saved)
    "queued" -> stringResource(R.string.treasury_state_queued)
    "processing" -> stringResource(R.string.treasury_state_processing)
    "ready" -> stringResource(R.string.treasury_state_ready)
    "partial" -> stringResource(R.string.treasury_state_partial)
    "failed" -> stringResource(R.string.treasury_state_failed)
    else -> state
}

private fun kindIcon(kind: String) = when (kind) {
    "link" -> Icons.Default.Link
    "image" -> Icons.Default.Image
    "document", "audio", "video" -> Icons.Default.Description
    else -> Icons.Default.Bookmark
}

private val nonRetryableProcessingErrors = setOf(
    "ocr_engine_unavailable",
    "transcription_not_authorized",
    "text_extractor_unavailable",
)

@Composable
private fun processingErrorLabel(code: String?): String = when (code) {
    "ocr_engine_unavailable" -> stringResource(R.string.treasury_error_ocr_unavailable)
    "transcription_not_authorized" -> stringResource(R.string.treasury_error_transcription_unavailable)
    "text_extractor_unavailable" -> stringResource(R.string.treasury_error_extractor_unavailable)
    "attachment_missing" -> stringResource(R.string.treasury_error_attachment_missing)
    "network_unavailable", "unsafe_or_offline_url" -> stringResource(R.string.treasury_error_network)
    "process_interrupted" -> stringResource(R.string.treasury_error_interrupted)
    else -> stringResource(R.string.treasury_error_generic)
}
