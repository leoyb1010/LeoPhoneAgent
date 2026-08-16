package com.leoyuan.leophoneagent.ui.relay

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.leoyuan.leophoneagent.relay.LeoFleetPresets
import com.leoyuan.leophoneagent.relay.RelayApproval
import com.leoyuan.leophoneagent.relay.RelayFleetClient
import com.leoyuan.leophoneagent.relay.RelayFleetStore
import com.leoyuan.leophoneagent.relay.RelayMachine
import com.leoyuan.leophoneagent.relay.RelaySession
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RelayFleetScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val store = remember { RelayFleetStore(context) }
    val config by store.config.collectAsState()
    val scope = rememberCoroutineScope()
    var base by remember(config.relayApiBase) { mutableStateOf(config.relayApiBase) }
    var key by remember(config.accessKey) { mutableStateOf(config.accessKey) }
    var machines by remember { mutableStateOf<List<RelayMachine>>(emptyList()) }
    var approvals by remember { mutableStateOf<List<RelayApproval>>(emptyList()) }
    val sessions = remember { mutableStateMapOf<String, List<RelaySession>>() }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var prompt by remember { mutableStateOf("") }
    var harness by remember { mutableStateOf("codex") }
    var cwd by remember { mutableStateOf("~") }
    var eventWatermark by remember { mutableStateOf(0.0) }

    fun refresh() {
        if (config.accessKey.length < 16 || loading) return
        scope.launch {
            loading = true
            error = null
            runCatching {
                val client = RelayFleetClient(config)
                val currentMachines = client.machines()
                machines = currentMachines
                currentMachines.filter { it.online }.map { machine ->
                    async { machine.name to client.sessions(machine.name) }
                }.awaitAll().forEach { (name, rows) -> sessions[name] = rows }
                val batch = client.relayEvents(eventWatermark)
                eventWatermark = batch.now
                approvals = (approvals + batch.approvals)
                    .distinctBy { "${it.machine}|${it.sessionId}|${it.approvalId}" }
            }.onFailure { error = it.message ?: "刷新失败" }
            loading = false
        }
    }

    LaunchedEffect(config.accessKey) { refresh() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("我的 Mac") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = ::refresh, enabled = !loading && config.accessKey.length >= 16) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "刷新")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("把 Mac 装进口袋", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "通过你自己的 Leo Relay 远程运行 Codex、Claude Code 和 Grok，手机休眠后 Mac 继续工作。",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("安全连接", fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(
                        value = base,
                        onValueChange = { base = it },
                        label = { Text("中继 API 地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = key,
                        onValueChange = { key = it },
                        label = { Text("中继密钥") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(
                            onClick = {
                                scope.launch {
                                    loading = true
                                    error = null
                                    runCatching {
                                        val draft = com.leoyuan.leophoneagent.relay.RelayFleetConfig(
                                            RelayFleetStore.normalizeBase(base), key.trim().trimEnd('%').trim(),
                                        )
                                        RelayFleetClient(draft).machines()
                                        store.save(base, key)
                                    }.onFailure { error = it.message ?: "连接失败" }
                                    loading = false
                                }
                            },
                            enabled = !loading && key.trim().length >= 16,
                        ) { Text("测试并保存") }
                        if (config.accessKey.isNotEmpty()) {
                            TextButton(onClick = { store.clear(); machines = emptyList(); sessions.clear() }) {
                                Text("断开")
                            }
                        }
                    }
                }
            }

            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            if (loading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.width(20.dp).height(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("正在同步舰队状态…")
                }
            }

            if (config.accessKey.length >= 16) {
                TaskComposer(
                    prompt = prompt,
                    onPromptChange = { prompt = it },
                    harness = harness,
                    onHarnessChange = { harness = it },
                    cwd = cwd,
                    onCwdChange = { cwd = it },
                )

                approvals.forEach { approval ->
                    ApprovalCard(approval) { choice ->
                        scope.launch {
                            loading = true
                            runCatching {
                                RelayFleetClient(config).approve(
                                    approval.machine, approval.sessionId, approval.approvalId, choice,
                                )
                                approvals = approvals.filterNot { it.approvalId == approval.approvalId }
                            }.onFailure { error = it.message }
                            loading = false
                        }
                    }
                }

                LeoFleetPresets.forEach { preset ->
                    val live = machines.firstOrNull { it.name == preset.machine }
                    MachineCard(
                        label = preset.label,
                        machine = preset.machine,
                        online = live?.online == true,
                        sessions = sessions[preset.machine].orEmpty(),
                        canStart = prompt.isNotBlank() && live?.online == true && !loading,
                        onStart = {
                            scope.launch {
                                loading = true
                                error = null
                                runCatching {
                                    RelayFleetClient(config).startTask(preset.machine, prompt, harness, cwd)
                                    prompt = ""
                                }.onFailure { error = it.message }
                                loading = false
                                refresh()
                            }
                        },
                        onStop = { sessionId ->
                            scope.launch {
                                loading = true
                                runCatching { RelayFleetClient(config).stop(preset.machine, sessionId) }
                                    .onFailure { error = it.message }
                                loading = false
                                refresh()
                            }
                        },
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun TaskComposer(
    prompt: String,
    onPromptChange: (String) -> Unit,
    harness: String,
    onHarnessChange: (String) -> Unit,
    cwd: String,
    onCwdChange: (String) -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.42f))) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("新建 Mac 任务", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(prompt, onPromptChange, label = { Text("让 Mac 完成什么？") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(harness, onHarnessChange, label = { Text("CLI") }, modifier = Modifier.weight(1f), singleLine = true)
                OutlinedTextField(cwd, onCwdChange, label = { Text("工作目录") }, modifier = Modifier.weight(1f), singleLine = true)
            }
            Text("在下方选择目标 Mac 启动。", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MachineCard(
    label: String,
    machine: String,
    online: Boolean,
    sessions: List<RelaySession>,
    canStart: Boolean,
    onStart: () -> Unit,
    onStop: (String) -> Unit,
) {
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Computer, contentDescription = null)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(label, fontWeight = FontWeight.SemiBold)
                    Text(machine, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(
                    Modifier.width(10.dp).height(10.dp).background(
                        if (online) Color(0xFF34C759) else MaterialTheme.colorScheme.outline,
                        CircleShape,
                    ),
                )
                Spacer(Modifier.width(6.dp))
                Text(if (online) "在线" else "离线", style = MaterialTheme.typography.labelMedium)
            }
            Button(onClick = onStart, enabled = canStart, modifier = Modifier.fillMaxWidth()) {
                Text("在这台 Mac 启动任务")
            }
            sessions.take(6).forEach { session ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${session.harness} · ${session.status}", style = MaterialTheme.typography.bodyMedium)
                        Text(session.id.take(12), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!session.isTerminal) {
                        OutlinedButton(onClick = { onStop(session.id) }) { Text("停止") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(approval: RelayApproval, onChoice: (String) -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.55f)),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("等待你审批", fontWeight = FontWeight.Bold)
            Text(approval.machine, style = MaterialTheme.typography.labelMedium)
            approval.command?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            approval.description?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                approval.choices.forEach { choice ->
                    if (choice == "deny") OutlinedButton(onClick = { onChoice(choice) }) { Text("拒绝") }
                    else Button(onClick = { onChoice(choice) }) { Text(choiceLabel(choice)) }
                }
            }
        }
    }
}

private fun choiceLabel(choice: String) = when (choice) {
    "once" -> "允许一次"
    "session" -> "本会话允许"
    "always" -> "始终允许"
    else -> choice
}
