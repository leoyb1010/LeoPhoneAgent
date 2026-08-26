package com.leoyuan.leophoneagent.power.txn

import com.leoyuan.leophoneagent.power.rules.AppRule
import com.leoyuan.leophoneagent.power.rules.AppRules

enum class RiskLevel {
    LOW, MEDIUM, HIGH, ALWAYS_CONFIRM;

    companion object {
        fun parse(raw: String): RiskLevel = when (raw.lowercase()) {
            "low" -> LOW
            "high" -> HIGH
            "always_confirm", "always-confirm" -> ALWAYS_CONFIRM
            else -> MEDIUM
        }
    }

    fun needsConfirm(): Boolean = this != LOW
}

enum class OpKind {
    FREEZE, UNFREEZE, UNINSTALL, CLEAR, GRANT, REVOKE, INSTALL;

    companion object {
        fun parse(raw: String): OpKind = when (raw.lowercase()) {
            "freeze", "disable" -> FREEZE
            "unfreeze", "enable" -> UNFREEZE
            "uninstall" -> UNINSTALL
            "clear" -> CLEAR
            "grant" -> GRANT
            "revoke" -> REVOKE
            "install" -> INSTALL
            else -> error("unknown action $raw")
        }
    }

    fun inverse(): OpKind? = when (this) {
        FREEZE -> UNFREEZE
        UNFREEZE -> FREEZE
        GRANT -> REVOKE
        REVOKE -> GRANT
        else -> null
    }

    fun labelZh(): String = when (this) {
        FREEZE -> "冻结"
        UNFREEZE -> "解冻"
        UNINSTALL -> "卸载"
        CLEAR -> "清理"
        GRANT -> "授权"
        REVOKE -> "撤权"
        INSTALL -> "安装"
    }
}

enum class Phase {
    CapabilityCheck, ReadOnlyScan, Plan, Risk, Confirm, Execute, PerItemResult, Rollback
}

data class PlannedOp(
    val pkg: String,
    val action: OpKind,
    val risk: RiskLevel,
    val ruleId: String,
    val permission: String? = null,
    val apk: String? = null,
)

data class ItemResult(
    val pkg: String,
    val action: OpKind,
    val ok: Boolean,
    val message: String,
    val rollbackable: Boolean,
)

data class Reply(
    val spoken: String,
    val chip: String = "系统事务",
    val phase: Phase,
    val degradeToModel: Boolean = false,
)

data class Intent(
    val kind: Kind,
    val targets: List<String> = emptyList(),
    val permission: String? = null,
    val apk: String? = null,
) {
    enum class Kind { Freeze, Unfreeze, Uninstall, Clear, Grant, Revoke, Install, Confirm, Cancel, Rollback }
}

class UnchangedGuard {
    private var last: String? = null
    private var count = 0

    fun note(fp: String): Boolean {
        if (fp == last) {
            count += 1
            return count >= 3
        }
        last = fp
        count = 1
        return false
    }
}

object PowerTxn {
    private val PKG = Regex("""[a-zA-Z][\w]*(?:\.[\w]+)+""")
    private val PERM = Regex("""android\.permission\.[A-Z0-9_]+""")

    fun parse(text: String): Intent? {
        val raw = text.trim()
        val lower = raw.lowercase()
        when {
            lower.matches(Regex("""^(确认|confirm|執行|执行)$""")) -> return Intent(Intent.Kind.Confirm)
            lower.matches(Regex("""^(取消|cancel)$""")) -> return Intent(Intent.Kind.Cancel)
            lower.matches(Regex("""^(回滚|回滾|rollback|undo)$""")) -> return Intent(Intent.Kind.Rollback)
        }
        val targets = PKG.findAll(raw).map { it.value }.toList()
        val perm = PERM.find(raw)?.value
        val apk = Regex("""\S+\.apk""").find(raw)?.value
        return when {
            isVerb(lower, "冻结", "凍結", "freeze", "停用这些", "停用這些") ->
                Intent(Intent.Kind.Freeze, targets)
            isVerb(lower, "解冻", "解凍", "unfreeze", "启用这些", "啟用這些") ->
                Intent(Intent.Kind.Unfreeze, targets)
            isVerb(lower, "卸载", "卸載", "uninstall") ->
                Intent(Intent.Kind.Uninstall, targets)
            isVerb(lower, "清理数据", "清理資料", "clear data", "清除数据", "清除資料") ->
                Intent(Intent.Kind.Clear, targets)
            isVerb(lower, "撤销权限", "撤銷權限", "revoke") ->
                Intent(Intent.Kind.Revoke, targets, permission = perm)
            isVerb(lower, "授予权限", "授予權限", "grant permission") ->
                Intent(Intent.Kind.Grant, targets, permission = perm)
            isVerb(lower, "安装", "安裝", "install apk") ->
                Intent(Intent.Kind.Install, apk = apk)
            else -> null
        }
    }

    fun resolveTargets(targets: List<String>, catalog: List<InstalledApp>): List<String> {
        return targets.mapNotNull { t ->
            if (t.contains('.')) t
            else catalog.firstOrNull { it.label.equals(t, true) || it.pkg.equals(t, true) }?.pkg
        }.distinct()
    }

    private fun isVerb(lower: String, vararg needles: String): Boolean =
        needles.any { lower.contains(it) }
}

class PowerTxnSession(
    private val rules: List<AppRule> = AppRules.bundled(),
) {
    var pending: List<PlannedOp>? = null
        private set
    var lastResults: List<ItemResult>? = null
        private set
    var alreadyDegraded: Boolean = false
        private set
    private var lastActionKey: String? = null
    val unchanged = UnchangedGuard()

    fun handle(text: String, actor: PackageActor): Reply? {
        val intent = PowerTxn.parse(text) ?: return null
        return when (intent.kind) {
            Intent.Kind.Confirm -> {
                val plan = pending ?: return null
                pending = null
                execute(plan, actor)
            }
            Intent.Kind.Cancel -> {
                if (pending == null) return null
                pending = null
                Reply("已取消这次系统事务。", phase = Phase.Confirm)
            }
            Intent.Kind.Rollback -> {
                val done = lastResults ?: return null
                rollback(done, actor)
            }
            else -> begin(intent, actor)
        }
    }

    private fun begin(intent: Intent, actor: PackageActor): Reply {
        when (actor.capability()) {
            Capability.Denied -> return Reply("这次系统事务被拒绝。到设置 → 权限 → 集成打开 Shizuku。", phase = Phase.CapabilityCheck)
            Capability.ServiceDown -> return Reply("Shizuku 服务没在跑。启动后再说一次。", phase = Phase.CapabilityCheck)
            Capability.NeedGrant -> return Reply("还没授权 Shizuku。到设置 → 权限里点一下。", phase = Phase.CapabilityCheck)
            Capability.Ready -> Unit
        }
        val action = intent.kind.toOp() ?: return Reply("还不支持这个系统操作。", phase = Phase.Plan, degradeToModel = !alreadyDegraded).also {
            if (it.degradeToModel) alreadyDegraded = true
        }
        val rule = AppRules.forAction(action, rules)
            ?: return Reply("没有匹配的规则，交给 Agent 一次。", phase = Phase.Plan, degradeToModel = !alreadyDegraded).also {
                if (it.degradeToModel) alreadyDegraded = true
            }
        if (rule.expiresAt != null && rule.expiresAt < System.currentTimeMillis()) {
            return Reply("规则 ${rule.id} 已过期。", phase = Phase.Plan)
        }
        val catalog = actor.listApps()
        val pkgs = when (action) {
            OpKind.INSTALL -> listOfNotNull(intent.apk)
            else -> PowerTxn.resolveTargets(intent.targets, catalog)
        }
        if (pkgs.isEmpty()) {
            return Reply("请给出要${action.labelZh()}的应用包名，例如 com.android.calculator2。", phase = Phase.ReadOnlyScan)
        }
        val ops = pkgs.map { pkg ->
            PlannedOp(pkg, action, rule.risk, rule.id, permission = intent.permission, apk = intent.apk)
        }
        val risk = ops.maxOf { it.risk }
        if (risk.needsConfirm()) {
            pending = ops
            val lines = ops.joinToString("\n") { "• ${it.action.labelZh()} ${it.pkg}" }
            return Reply(
                "只读扫描后的计划（风险 ${risk.name}）：\n$lines\n回复「确认」执行，或「取消」。",
                phase = Phase.Confirm,
            )
        }
        return execute(ops, actor)
    }

    private fun execute(ops: List<PlannedOp>, actor: PackageActor): Reply {
        val always = ops.any { it.risk == RiskLevel.ALWAYS_CONFIRM || it.action in ALWAYS }
        if (always && !actor.confirm("系统事务", ops.joinToString("\n") { "${it.action.labelZh()} ${it.pkg}" })) {
            return Reply("未确认，没有改任何应用。", phase = Phase.Confirm)
        }
        val out = mutableListOf<ItemResult>()
        for (op in ops) {
            val key = "${op.action}:${op.pkg}:${op.permission ?: ""}"
            if (key == lastActionKey) {
                out += ItemResult(op.pkg, op.action, false, "连续重复动作，已停止。", false)
                break
            }
            val fp = actor.fingerprint()
            if (fp != null && unchanged.note(fp)) {
                out += ItemResult(op.pkg, op.action, false, "屏幕三次无变化，已恢复停止。", false)
                break
            }
            val ran = runOp(actor, op.action, op.pkg, op.permission, op.apk)
            val verified = ran.ok && verifySuccess(actor, op)
            lastActionKey = key
            out += ItemResult(
                pkg = op.pkg,
                action = op.action,
                ok = verified,
                message = if (verified) "完成" else ran.message.ifBlank { "失败" },
                rollbackable = verified && op.action.inverse() != null,
            )
        }
        lastResults = out
        val failed = out.count { !it.ok }
        if (failed == out.size && !alreadyDegraded) {
            alreadyDegraded = true
            return Reply(
                perItemText(out) + "\n规则失败，交给 Agent 一次。",
                phase = Phase.PerItemResult,
                degradeToModel = true,
            )
        }
        val canRoll = out.any { it.rollbackable }
        val tail = if (canRoll) "\n回复「回滚」可恢复已成功的项。" else ""
        return Reply(perItemText(out) + tail, phase = Phase.PerItemResult)
    }

    private fun rollback(done: List<ItemResult>, actor: PackageActor): Reply {
        val inverses = done.filter { it.rollbackable }.mapNotNull { item ->
            item.action.inverse()?.let { PlannedOp(item.pkg, it, RiskLevel.MEDIUM, "rollback") }
        }
        if (inverses.isEmpty()) return Reply("没有可回滚的项。", phase = Phase.Rollback)
        lastResults = null
        lastActionKey = null
        val executed = execute(inverses, actor)
        return executed.copy(phase = Phase.Rollback, spoken = "回滚结果：\n" + executed.spoken)
    }

    private fun verifySuccess(actor: PackageActor, op: PlannedOp): Boolean {
        val rule = AppRules.forAction(op.action, rules) ?: return true
        val sel = rule.successSelector ?: return true
        return when (sel.type) {
            "pm-enabled" -> actor.enabled(op.pkg)?.let { it == sel.equals } ?: true
            else -> true
        }
    }

    private fun perItemText(items: List<ItemResult>): String =
        items.joinToString("\n") {
            val mark = if (it.ok) "✓" else "✗"
            "$mark ${it.action.labelZh()} ${it.pkg}：${it.message}"
        }

    private fun Intent.Kind.toOp(): OpKind? = when (this) {
        Intent.Kind.Freeze -> OpKind.FREEZE
        Intent.Kind.Unfreeze -> OpKind.UNFREEZE
        Intent.Kind.Uninstall -> OpKind.UNINSTALL
        Intent.Kind.Clear -> OpKind.CLEAR
        Intent.Kind.Grant -> OpKind.GRANT
        Intent.Kind.Revoke -> OpKind.REVOKE
        Intent.Kind.Install -> OpKind.INSTALL
        else -> null
    }

    companion object {
        private val ALWAYS = setOf(OpKind.UNINSTALL, OpKind.CLEAR, OpKind.GRANT, OpKind.REVOKE, OpKind.INSTALL)

        fun runOp(
            actor: PackageActor,
            action: OpKind,
            pkg: String,
            permission: String?,
            apk: String?,
        ): ActorResult {
            return when (action) {
                OpKind.FREEZE -> actor.freeze(pkg)
                OpKind.UNFREEZE -> actor.unfreeze(pkg)
                OpKind.UNINSTALL -> actor.uninstall(pkg)
                OpKind.CLEAR -> actor.clear(pkg)
                OpKind.GRANT -> {
                    if (permission == null) ActorResult(false, "缺少权限名")
                    else actor.grant(pkg, permission)
                }
                OpKind.REVOKE -> {
                    if (permission == null) ActorResult(false, "缺少权限名")
                    else actor.revoke(pkg, permission)
                }
                OpKind.INSTALL -> {
                    if (apk == null) ActorResult(false, "缺少 apk 路径")
                    else actor.install(apk)
                }
            }
        }
    }
}
