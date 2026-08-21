package com.leoyuan.leophoneagent.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.sandbox.CliToolCatalog
import com.leoyuan.leophoneagent.sandbox.CliToolId
import com.leoyuan.leophoneagent.sandbox.CliLaunchError
import com.leoyuan.leophoneagent.sandbox.CliToolPreference
import com.leoyuan.leophoneagent.sandbox.CliToolPreferences
import com.leoyuan.leophoneagent.ui.components.SettingsSection

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CliToolsScreen(
    onBack: () -> Unit,
    onOpenRootfs: () -> Unit,
    onOpenTerminal: (CliToolId, CliToolPreference) -> CliLaunchError?,
    viewModel: CliToolsViewModel = viewModel(),
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val state by viewModel.uiState.collectAsState()
    var pending by remember { mutableStateOf<CliToolId?>(null) }
    var uninstalling by remember { mutableStateOf<CliToolId?>(null) }
    var configuring by remember { mutableStateOf<CliToolId?>(null) }
    var menuFor by remember { mutableStateOf<CliToolId?>(null) }
    var draftModel by remember { mutableStateOf("") }
    var draftUseLeoKey by remember { mutableStateOf(false) }
    var launchError by remember { mutableStateOf<CliLaunchError?>(null) }
    var logExpanded by remember { mutableStateOf(false) }
    val preferenceStore = remember { CliToolPreferences(context) }
    var preferences by remember {
        mutableStateOf(CliToolId.entries.associateWith(preferenceStore::get))
    }
    val groupedBg = MaterialTheme.colorScheme.surfaceContainerLowest

    LaunchedEffect(Unit) { viewModel.refresh(context) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.cli_tools_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back))
                    }
                },
                actions = {
                    IconButton(
                        onClick = { viewModel.refresh(context) },
                        enabled = !state.refreshing && state.busyTool == null,
                    ) {
                        if (state.refreshing) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Refresh, stringResource(R.string.cli_tools_refresh))
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = groupedBg),
            )
        },
        containerColor = groupedBg,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(groupedBg)
                .verticalScroll(rememberScrollState()),
        ) {
            Spacer(Modifier.size(8.dp))
            Text(
                text = stringResource(R.string.cli_tools_intro),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )

            if (!state.rootfsReady) {
                SettingsSection(title = stringResource(R.string.cli_tools_linux_required)) {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.cli_tools_linux_missing)) },
                        supportingContent = { Text(stringResource(R.string.cli_tools_linux_missing_subtitle)) },
                        leadingContent = {
                            Icon(Icons.Default.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                        },
                        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpenRootfs),
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
            }

            CliToolCatalog.tools.forEach { tool ->
                val status = state.statuses.getValue(tool.id)
                val busy = state.busyTool == tool.id
                SettingsSection(title = tool.displayName) {
                    ListItem(
                        headlineContent = {
                            Text(
                                if (status.installed) stringResource(R.string.cli_tools_installed)
                                else stringResource(R.string.cli_tools_not_installed),
                            )
                        },
                        supportingContent = {
                            Text(status.version ?: stringResource(descriptionFor(tool.id)))
                        },
                        leadingContent = {
                            Icon(
                                if (status.installed) Icons.Default.CheckCircle else Icons.Default.Download,
                                contentDescription = null,
                                tint = if (status.installed) Color(0xFF34C759) else MaterialTheme.colorScheme.primary,
                            )
                        },
                        trailingContent = {
                            // [T-cli-card-hierarchy] Overflow menu carries the
                            // secondary actions; the old flat 4-button spread
                            // gave 打开终端 and 更新 identical visual weight.
                            Box {
                                IconButton(
                                    onClick = { menuFor = tool.id },
                                    enabled = state.busyTool == null,
                                ) {
                                    Icon(
                                        Icons.Default.MoreVert,
                                        stringResource(R.string.cli_tools_more_actions),
                                    )
                                }
                                DropdownMenu(
                                    expanded = menuFor == tool.id,
                                    onDismissRequest = { menuFor = null },
                                ) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.cli_tools_model_and_auth)) },
                                        onClick = {
                                            menuFor = null
                                            val saved = preferences.getValue(tool.id)
                                            draftModel = saved.model
                                            draftUseLeoKey = saved.useLeoApiKey
                                            configuring = tool.id
                                        },
                                    )
                                    if (status.installed) {
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.cli_tools_update)) },
                                            onClick = { menuFor = null; pending = tool.id },
                                        )
                                        DropdownMenuItem(
                                            text = {
                                                Text(
                                                    stringResource(R.string.cli_tools_uninstall),
                                                    color = MaterialTheme.colorScheme.error,
                                                )
                                            },
                                            onClick = { menuFor = null; uninstalling = tool.id },
                                        )
                                    }
                                }
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )

                    if (busy) {
                        LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 16.dp))
                        state.progressLine?.let { line ->
                            Text(
                                line,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                        // [T-cli-install-log] The single truncated line hid
                        // real installer errors; full rolling log on demand.
                        TextButton(
                            onClick = { logExpanded = !logExpanded },
                            modifier = Modifier.padding(horizontal = 8.dp),
                        ) {
                            Text(
                                stringResource(
                                    if (logExpanded) R.string.cli_tools_hide_log
                                    else R.string.cli_tools_show_log,
                                ),
                            )
                        }
                        if (logExpanded) {
                            InstallLogBox(state.progressLog)
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (status.installed) {
                            // [T-cli-launch-primary] 启动 is THE action once a
                            // tool is installed — filled button, auto-runs.
                            Button(
                                onClick = {
                                    launchError = onOpenTerminal(tool.id, preferences.getValue(tool.id))
                                },
                                enabled = state.busyTool == null,
                                modifier = Modifier.weight(1f),
                            ) {
                                Icon(Icons.Default.PlayArrow, null, Modifier.size(18.dp))
                                Spacer(Modifier.size(6.dp))
                                Text(stringResource(R.string.cli_tools_launch))
                            }
                            OutlinedButton(
                                onClick = { pending = tool.id },
                                enabled = state.busyTool == null,
                                modifier = Modifier.weight(1f),
                            ) { Text(stringResource(R.string.cli_tools_update)) }
                        } else {
                            Button(
                                onClick = { pending = tool.id },
                                enabled = state.rootfsReady && state.busyTool == null,
                                modifier = Modifier.weight(1f),
                            ) { Text(stringResource(R.string.cli_tools_install)) }
                        }
                    }
                }
            }

            if (state.busyTool != null) {
                TextButton(
                    onClick = viewModel::cancel,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                ) { Text(stringResource(R.string.cli_tools_cancel_operation)) }
            }
            Spacer(Modifier.size(24.dp))
        }
    }

    pending?.let { id ->
        val tool = CliToolCatalog.get(id)
        val installed = state.statuses.getValue(id).installed
        AlertDialog(
            onDismissRequest = { pending = null },
            title = {
                Text(
                    stringResource(
                        if (installed) R.string.cli_tools_confirm_update_title
                        else R.string.cli_tools_confirm_install_title,
                        tool.displayName,
                    ),
                )
            },
            text = { Text(stringResource(R.string.cli_tools_confirm_message, tool.sourceHost)) },
            confirmButton = {
                TextButton(onClick = {
                    pending = null
                    viewModel.installOrUpdate(context, id)
                }) { Text(stringResource(R.string.cli_tools_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { pending = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    uninstalling?.let { id ->
        val tool = CliToolCatalog.get(id)
        AlertDialog(
            onDismissRequest = { uninstalling = null },
            title = { Text(stringResource(R.string.cli_tools_uninstall_title, tool.displayName)) },
            text = { Text(stringResource(R.string.cli_tools_uninstall_message)) },
            confirmButton = {
                TextButton(onClick = {
                    uninstalling = null
                    viewModel.uninstall(context, id)
                }) {
                    Text(
                        stringResource(R.string.cli_tools_uninstall),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { uninstalling = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    configuring?.let { id ->
        val tool = CliToolCatalog.get(id)
        val bridgeSupported = id != CliToolId.CURSOR
        AlertDialog(
            onDismissRequest = { configuring = null },
            title = { Text(stringResource(R.string.cli_tools_model_title, tool.displayName)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = draftModel,
                        onValueChange = { value ->
                            if (value.length <= 200 && value.none(Char::isISOControl)) draftModel = value
                        },
                        label = { Text(stringResource(R.string.cli_tools_model_label)) },
                        supportingText = { Text(stringResource(R.string.cli_tools_model_hint)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.cli_tools_use_leo_key))
                            Text(
                                stringResource(
                                    if (bridgeSupported) R.string.cli_tools_use_leo_key_subtitle
                                    else R.string.cli_tools_cursor_key_boundary,
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = draftUseLeoKey && bridgeSupported,
                            onCheckedChange = { draftUseLeoKey = it },
                            enabled = bridgeSupported,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val saved = CliToolPreference(draftModel.trim(), draftUseLeoKey && bridgeSupported)
                    preferenceStore.save(id, saved)
                    preferences = preferences.toMutableMap().apply { put(id, saved) }
                    configuring = null
                }) { Text(stringResource(R.string.cli_tools_save)) }
            },
            dismissButton = {
                TextButton(onClick = { configuring = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }

    launchError?.let { error ->
        AlertDialog(
            onDismissRequest = { launchError = null },
            title = { Text(stringResource(R.string.cli_tools_auth_unavailable)) },
            text = { Text(stringResource(errorMessage(error))) },
            confirmButton = {
                TextButton(onClick = { launchError = null }) { Text(stringResource(R.string.cli_tools_confirm)) }
            },
        )
    }

    when (val result = state.result) {
        null -> Unit
        is CliOperationResult.Success -> {
            val tool = CliToolCatalog.get(result.toolId)
            AlertDialog(
                onDismissRequest = viewModel::clearResult,
                title = { Text(stringResource(R.string.cli_tools_operation_success)) },
                text = { Text(stringResource(R.string.cli_tools_ready, tool.displayName)) },
                confirmButton = {
                    // [T-cli-zero-depth] Installed → straight into the tool.
                    TextButton(onClick = {
                        viewModel.clearResult()
                        launchError = onOpenTerminal(result.toolId, preferences.getValue(result.toolId))
                    }) { Text(stringResource(R.string.cli_tools_launch)) }
                },
                dismissButton = {
                    TextButton(onClick = viewModel::clearResult) {
                        Text(stringResource(R.string.cli_tools_done))
                    }
                },
            )
        }
        is CliOperationResult.Uninstalled -> {
            val tool = CliToolCatalog.get(result.toolId)
            AlertDialog(
                onDismissRequest = viewModel::clearResult,
                title = { Text(stringResource(R.string.cli_tools_uninstalled_title)) },
                text = { Text(stringResource(R.string.cli_tools_uninstalled_message, tool.displayName)) },
                confirmButton = {
                    TextButton(onClick = viewModel::clearResult) {
                        Text(stringResource(R.string.cli_tools_confirm))
                    }
                },
            )
        }
        is CliOperationResult.Failure -> {
            AlertDialog(
                onDismissRequest = viewModel::clearResult,
                title = { Text(stringResource(R.string.cli_tools_operation_failed)) },
                text = {
                    Column {
                        Text(stringResource(R.string.cli_tools_failure_hint))
                        Spacer(Modifier.height(8.dp))
                        InstallLogBox(result.log.lines())
                    }
                },
                confirmButton = {
                    if (result.retryable) {
                        TextButton(onClick = {
                            viewModel.clearResult()
                            viewModel.installOrUpdate(context, result.toolId)
                        }) { Text(stringResource(R.string.cli_tools_retry)) }
                    } else {
                        TextButton(onClick = viewModel::clearResult) {
                            Text(stringResource(R.string.cli_tools_confirm))
                        }
                    }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = {
                            clipboard.setText(AnnotatedString(result.log))
                        }) { Text(stringResource(R.string.cli_tools_copy_log)) }
                        TextButton(onClick = viewModel::clearResult) {
                            Text(stringResource(R.string.common_cancel))
                        }
                    }
                },
            )
        }
    }
}

/** Monospace scrollable log surface shared by busy state and failure dialog. */
@Composable
private fun InstallLogBox(lines: List<String>) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .height(180.dp)
            .background(
                MaterialTheme.colorScheme.surfaceContainerHighest,
                RoundedCornerShape(8.dp),
            ),
    ) {
        val scroll = rememberScrollState()
        // Follow the tail as new lines stream in.
        LaunchedEffect(lines.size) { scroll.scrollTo(scroll.maxValue) }
        Text(
            lines.joinToString("\n"),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(10.dp),
        )
    }
}

private fun descriptionFor(id: CliToolId): Int = when (id) {
    CliToolId.CLAUDE -> R.string.cli_tools_claude_description
    CliToolId.CODEX -> R.string.cli_tools_codex_description
    CliToolId.GROK -> R.string.cli_tools_grok_description
    CliToolId.CURSOR -> R.string.cli_tools_cursor_description
}

private fun errorMessage(error: CliLaunchError): Int = when (error) {
    CliLaunchError.UNSUPPORTED -> R.string.cli_tools_auth_unsupported
    CliLaunchError.NO_CURRENT_MODEL -> R.string.cli_tools_auth_no_model
    CliLaunchError.PROVIDER_MISMATCH -> R.string.cli_tools_auth_provider_mismatch
    CliLaunchError.OAUTH_NOT_EXPORTABLE -> R.string.cli_tools_auth_oauth_boundary
    CliLaunchError.CUSTOM_ENDPOINT_UNSUPPORTED -> R.string.cli_tools_auth_custom_endpoint
    CliLaunchError.NO_API_KEY -> R.string.cli_tools_auth_no_key
}
