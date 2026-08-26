package com.leoyuan.leophoneagent.ui.relay

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.ui.platform.LocalContext
import com.leoyuan.leophoneagent.relay.RelayPairCodec
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.leoyuan.leophoneagent.relay.FleetListMerge
import com.leoyuan.leophoneagent.relay.LeoFleetPresets
import com.leoyuan.leophoneagent.relay.RelayApproval
import com.leoyuan.leophoneagent.relay.RelayFleetClient
import com.leoyuan.leophoneagent.relay.RelayFleetStore
import com.leoyuan.leophoneagent.relay.RelayEventsExpiredException
import com.leoyuan.leophoneagent.relay.RelayMachine
import com.leoyuan.leophoneagent.relay.RelaySession
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RelayFleetScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val store = remember { RelayFleetStore.get(context) }
    val config by store.config.collectAsState()
    val scope = rememberCoroutineScope()
    var base by remember(config.relayApiBase) { mutableStateOf(config.relayApiBase) }
    var key by remember(config.accessKey) { mutableStateOf(config.accessKey) }
    var machines by remember { mutableStateOf<List<RelayMachine>>(emptyList()) }
    var approvals by remember { mutableStateOf<List<RelayApproval>>(emptyList()) }
    LaunchedEffect(approvals.size) {
        com.leoyuan.leophoneagent.service.SessionTaskStatus.setPendingApprovals(approvals.size)
    }
    val sessions = remember { mutableStateMapOf<String, List<RelaySession>>() }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var prompt by remember { mutableStateOf("") }
    var harness by remember { mutableStateOf("codex") }
    var cwd by remember { mutableStateOf("~") }
    var eventWatermark by remember { mutableStateOf(0.0) }
    val sessionEventSeq = remember { mutableStateMapOf<String, Int>() }

    // P2#18：原来 refresh / 审批 / 启动 / 停止 四处各自 `RelayFleetClient(config)`，
    // 而它的默认构造会 new 一个全新的 OkHttpClient —— 每次点击都新建一份连接池
    // 和线程池，连接无法复用。按 config 记忆一个实例即可（RelayFleetClient 是
    // 无状态的，只读 config）。config 变化时自然重建。
    val fleetClient = remember(config.relayApiBase, config.accessKey) {
        runCatching { RelayFleetClient(config) }.getOrNull()
    }

    // P2#16/#17：机器名此前有两个来源 —— 这里用裸 `Build.MODEL`，
    // `RelayBodyService` 用 `defaultMachineName()`（做过空格归一化）。
    // 谁先跑到谁写进存储，而这个名字会进 `/m/<machine>` 路径，两边不一致
    // 就是两台机器。统一走 defaultMachineName。
    // 另外 `remember { store.ensureMachineName(...) }` 会在**组合期**写
    // SharedPreferences 并改 StateFlow（副作用写在组合里，重组时机不受控），
    // 改到 LaunchedEffect 里做。
    var machineName by remember { mutableStateOf(config.machineName) }
    LaunchedEffect(config.accessKey, config.bodyEnabled) {
        if (config.accessKey.length >= 16 && config.bodyEnabled) {
            // ensureMachineName 会写加密存储（AES + 磁盘），别放主线程。
            machineName = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                store.ensureMachineName(
                    com.leoyuan.leophoneagent.relay.RelayBodyService.defaultMachineName(context),
                )
            }
        }
    }

    fun refresh() {
        if (config.accessKey.length < 16 || loading) return
        scope.launch {
            loading = true
            error = null
            runCatching {
                val client = requireNotNull(fleetClient) { "未配置中继密钥" }
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

    // Live-follow every non-terminal session. The key intentionally excludes
    // status/lastEvent so an arriving delta updates the row without tearing
    // down and rebuilding the EventSource. A terminal event removes the key,
    // which cancels the collector cleanly.
    val liveSessionKeys = sessions.entries
        .flatMap { (machine, rows) -> rows.filterNot { it.isTerminal }.map { machine to it.id } }
        .sortedBy { "${it.first}|${it.second}" }
    LaunchedEffect(fleetClient, liveSessionKeys) {
        val client = fleetClient ?: return@LaunchedEffect
        liveSessionKeys.forEach { (machine, sessionId) ->
            launch {
                val key = "$machine|$sessionId"
                var retryDelayMs = 750L
                while (true) {
                    val current = sessions[machine].orEmpty().firstOrNull { it.id == sessionId }
                    if (current == null || current.isTerminal) break
                    val outcome = runCatching {
                        client.sessionEvents(machine, sessionId, sessionEventSeq[key] ?: 0)
                            .collect { event ->
                                if (event.seq <= (sessionEventSeq[key] ?: 0)) return@collect
                                sessionEventSeq[key] = event.seq
                                val newStatus = when (event.event) {
                                    "run.completed" -> "completed"
                                    "run.failed" -> "failed"
                                    "run.cancelled" -> "cancelled"
                                    "message.delta", "tool.started", "tool.completed" -> "running"
                                    else -> null
                                }
                                val preview = event.delta?.takeLast(180)
                                    ?: event.output?.takeLast(180)
                                    ?: event.event
                                sessions[machine] = sessions[machine].orEmpty().map { row ->
                                    if (row.id == sessionId) row.copy(
                                        status = newStatus ?: row.status,
                                        lastEvent = preview,
                                    ) else row
                                }
                                if (event.event == "approval.request" && event.approvalId != null) {
                                    approvals = (approvals + RelayApproval(
                                        machine = machine,
                                        sessionId = sessionId,
                                        approvalId = event.approvalId,
                                        command = event.command,
                                        description = event.description,
                                        choices = event.choices.ifEmpty { listOf("once", "deny") },
                                        seq = event.seq,
                                    )).distinctBy { "${it.machine}|${it.sessionId}|${it.approvalId}" }
                                }
                                retryDelayMs = 750L
                            }
                    }
                    val latest = sessions[machine].orEmpty().firstOrNull { it.id == sessionId }
                    if (latest == null || latest.isTerminal) break
                    // A normal close before a terminal event is still a lost
                    // network edge. Resume from seq with bounded backoff.
                    outcome.exceptionOrNull()?.let { failure ->
                        if (failure is RelayEventsExpiredException) {
                            sessionEventSeq[key] = failure.minAfter
                        }
                        android.util.Log.w("RelayFleetSSE", "session stream reconnect: ${failure.message}")
                    }
                    delay(retryDelayMs)
                    retryDelayMs = (retryDelayMs * 2).coerceAtMost(8_000L)
                }
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("远程机器") },
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
            Text("把已装本 App 的机器装进口袋", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "列表来自中继 /machines。三台 Mac 仍可作为快捷入口；新上线的 Android 身体不用改仓库字符串。本机保存密钥后也会作为身体注册。",
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
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("允许本机接受远程任务", fontWeight = FontWeight.Medium)
                            // review P0#2：原文案只说"远程可驱动本机 Agent"，
                            // 没说清远程能碰到哪些数据。这里明确列出隐私工具，
                            // 并说明开启期间它们一律先在本机弹确认
                            // （OffloadPermissionManager.setRemoteBodyEnabled）。
                            Text(
                                androidx.compose.ui.res.stringResource(
                                    com.leoyuan.leophoneagent.R.string.relay_body_toggle_caption,
                                ),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = config.bodyEnabled,
                            onCheckedChange = store::setBodyEnabled,
                            enabled = config.accessKey.length >= 16,
                        )
                    }
                }
            }

            // machineName 现在由上面的 LaunchedEffect 异步落地，未就绪时先不
            // 出示配对码 —— 名字为空的码扫出来会指向一台不存在的机器。
            if (config.accessKey.length >= 16 && config.bodyEnabled && machineName.isNotBlank()) {
                val pair = RelayPairCodec.encode(config.relayApiBase, machineName)
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("出示配对码", fontWeight = FontWeight.SemiBold)
                        Text("码里只有中继根和本机名，钥匙不在里面。用 iPhone 扫或粘贴即可加入列表。")
                        Text(pair, style = MaterialTheme.typography.bodySmall)
                        OutlinedButton(onClick = {
                            val clipboard = context.getSystemService(ClipboardManager::class.java)
                            clipboard?.setPrimaryClip(ClipData.newPlainText("leoagent-pair", pair))
                        }) { Text("复制配对码") }
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
                                requireNotNull(fleetClient) { "未配置中继密钥" }.approve(
                                    approval.machine, approval.sessionId, approval.approvalId, choice,
                                )
                                approvals = approvals.filterNot { it.approvalId == approval.approvalId }
                            }.onFailure { error = it.message }
                            loading = false
                        }
                    }
                }

                FleetListMerge.displayMachines(machines, LeoFleetPresets).forEach { row ->
                    val startHarness = if (row.isAndroidBody) "minis" else harness
                    MachineCard(
                        label = row.label,
                        machine = row.machine,
                        online = row.online,
                        isAndroidBody = row.isAndroidBody,
                        sessions = sessions[row.machine].orEmpty(),
                        canStart = prompt.isNotBlank() && row.online && !loading,
                        onStart = {
                            scope.launch {
                                loading = true
                                error = null
                                runCatching {
                                    requireNotNull(fleetClient) { "未配置中继密钥" }
                                        .startTask(row.machine, prompt, startHarness, cwd)
                                    prompt = ""
                                }.onFailure { error = it.message }
                                loading = false
                                refresh()
                            }
                        },
                        onStop = { sessionId ->
                            scope.launch {
                                loading = true
                                runCatching { requireNotNull(fleetClient) { "未配置中继密钥" }.stop(row.machine, sessionId) }
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
            Text("新建远程任务", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(prompt, onPromptChange, label = { Text("让这台机器完成什么？") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(harness, onHarnessChange, label = { Text("CLI") }, modifier = Modifier.weight(1f), singleLine = true)
                OutlinedTextField(cwd, onCwdChange, label = { Text("工作目录") }, modifier = Modifier.weight(1f), singleLine = true)
            }
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    "codex" to "Codex",
                    "claude" to "Claude Code",
                    "cursor" to "Cursor",
                    "grok" to "Grok",
                    "minis" to "Android Agent",
                ).forEach { (key, label) ->
                    FilterChip(
                        selected = harness == key,
                        onClick = { onHarnessChange(key) },
                        label = { Text(label) },
                    )
                }
            }
            Text("在下方选择目标机器启动。Android 身体会自动走 minis。", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MachineCard(
    label: String,
    machine: String,
    online: Boolean,
    isAndroidBody: Boolean = false,
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
                Text(if (isAndroidBody) "在这台 Android 启动任务" else "在这台 Mac 启动任务")
            }
            sessions.take(6).forEach { session ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${session.harness} · ${session.status}", style = MaterialTheme.typography.bodyMedium)
                        session.windowLabel?.let { window ->
                            Text(window, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                        Text(session.id.take(12), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        session.lastEvent?.takeIf { it.isNotBlank() }?.let { last ->
                            Text(
                                last,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                            )
                        }
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
