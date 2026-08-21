package com.leoyuan.leophoneagent.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
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
    val state by viewModel.uiState.collectAsState()
    var pending by remember { mutableStateOf<CliToolId?>(null) }
    var configuring by remember { mutableStateOf<CliToolId?>(null) }
    var draftModel by remember { mutableStateOf("") }
    var draftUseLeoKey by remember { mutableStateOf(false) }
    var launchError by remember { mutableStateOf<CliLaunchError?>(null) }
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
                            Text(
                                tool.sourceHost,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
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
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Button(
                            onClick = { pending = tool.id },
                            enabled = state.rootfsReady && state.busyTool == null,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(
                                if (status.installed) stringResource(R.string.cli_tools_update)
                                else stringResource(R.string.cli_tools_install),
                            )
                        }
                        OutlinedButton(
                            onClick = {
                                launchError = onOpenTerminal(tool.id, preferences.getValue(tool.id))
                            },
                            enabled = status.installed && state.busyTool == null,
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Outlined.Terminal, null, Modifier.size(18.dp))
                            Spacer(Modifier.size(6.dp))
                            Text(stringResource(R.string.cli_tools_open_terminal))
                        }
                    }
                    TextButton(
                        onClick = {
                            val saved = preferences.getValue(tool.id)
                            draftModel = saved.model
                            draftUseLeoKey = saved.useLeoApiKey
                            configuring = tool.id
                        },
                        enabled = state.busyTool == null,
                        modifier = Modifier.align(Alignment.End).padding(horizontal = 8.dp),
                    ) { Text(stringResource(R.string.cli_tools_model_and_auth)) }
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

    state.resultMessage?.let { message ->
        AlertDialog(
            onDismissRequest = viewModel::clearResult,
            title = {
                Text(
                    stringResource(
                        if (state.operationSucceeded) R.string.cli_tools_operation_success
                        else R.string.cli_tools_operation_failed,
                    ),
                )
            },
            text = {
                Text(
                    if (state.operationSucceeded) stringResource(R.string.cli_tools_ready, message)
                    else message,
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::clearResult) { Text(stringResource(R.string.cli_tools_confirm)) }
            },
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
