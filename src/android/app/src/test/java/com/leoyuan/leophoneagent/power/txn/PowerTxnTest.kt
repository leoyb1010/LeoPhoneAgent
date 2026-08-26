package com.leoyuan.leophoneagent.power.txn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PowerTxnTest {
    private val catalog = listOf(
        InstalledApp("com.android.calculator2", "计算器"),
        InstalledApp("com.android.deskclock", "时钟"),
        InstalledApp("com.android.calendar", "日历"),
    )

    @Test
    fun parseFreezeThreePackages() {
        val hit = PowerTxn.parse("冻结这 3 个 App com.android.calculator2 com.android.deskclock com.android.calendar")
        assertEquals(Intent.Kind.Freeze, hit!!.kind)
        assertEquals(3, hit.targets.size)
    }

    @Test
    fun resolveLabelAndPackage() {
        val pkgs = PowerTxn.resolveTargets(listOf("计算器", "com.android.deskclock"), catalog)
        assertEquals(listOf("com.android.calculator2", "com.android.deskclock"), pkgs)
    }

    @Test
    fun freezeThreeThenRollback() {
        val actor = FakeActor(catalog)
        val session = PowerTxnSession()
        val plan = session.handle(
            "冻结 com.android.calculator2 com.android.deskclock com.android.calendar",
            actor,
        )!!
        assertEquals(Phase.Confirm, plan.phase)
        assertTrue(plan.spoken.contains("calculator2"))

        val done = session.handle("确认", actor)!!
        assertEquals(Phase.PerItemResult, done.phase)
        assertEquals(setOf("com.android.calculator2", "com.android.deskclock", "com.android.calendar"), actor.frozen)
        assertTrue(done.spoken.contains("回滚"))

        val rolled = session.handle("回滚", actor)!!
        assertEquals(Phase.Rollback, rolled.phase)
        assertTrue(actor.frozen.isEmpty())
    }

    @Test
    fun capabilityDeniedStopsBeforeScan() {
        val actor = FakeActor(catalog, cap = Capability.Denied)
        val reply = PowerTxnSession().handle("冻结 com.android.calculator2", actor)!!
        assertEquals(Phase.CapabilityCheck, reply.phase)
        assertTrue(actor.frozen.isEmpty())
    }

    @Test
    fun uninstallAlwaysConfirms() {
        val actor = FakeActor(catalog, confirm = false)
        val session = PowerTxnSession()
        session.handle("卸载 com.android.calculator2", actor)
        val done = session.handle("确认", actor)!!
        assertTrue(done.spoken.contains("未确认"))
        assertFalse(actor.uninstalled.contains("com.android.calculator2"))
    }

    @Test
    fun consecutiveDuplicateStops() {
        val actor = FakeActor(catalog)
        val session = PowerTxnSession()
        session.handle("冻结 com.android.calculator2", actor)
        session.handle("确认", actor)
        session.handle("冻结 com.android.calculator2", actor)
        val done = session.handle("确认", actor)!!
        assertTrue(done.spoken.contains("连续重复"))
        assertEquals(setOf("com.android.calculator2"), actor.frozen)
    }

    @Test
    fun unchangedScreenRecovers() {
        val actor = FakeActor(catalog, fingerprint = "same")
        val session = PowerTxnSession()
        session.handle("冻结 com.android.calculator2 com.android.deskclock com.android.calendar", actor)
        val done = session.handle("确认", actor)!!
        assertTrue(done.spoken.contains("屏幕三次无变化") || done.spoken.contains("完成"))
        // first op notes fp (count=1), second count=2, third count=3 → stop on third
        assertTrue(actor.frozen.size <= 2)
        assertTrue(done.spoken.contains("屏幕三次无变化"))
    }

    @Test
    fun unknownIntentIsNull() {
        assertNull(PowerTxn.parse("今天天气怎么样"))
        assertNull(PowerTxnSession().handle("今天天气怎么样", FakeActor(catalog)))
    }

    @Test
    fun fiveBundledRulesPresent() {
        val rules = com.leoyuan.leophoneagent.power.rules.AppRules.bundled()
        val ids = rules.map { it.id }
        assertEquals(listOf("freeze", "unfreeze", "uninstall", "clear", "revoke"), ids)
        assertNull(rules.first { it.id == "uninstall" }.rollback)
        assertNull(rules.first { it.id == "clear" }.rollback)
        assertEquals(OpKind.UNFREEZE, rules.first { it.id == "freeze" }.rollback)
    }
}

private class FakeActor(
    private val catalog: List<InstalledApp>,
    private val cap: Capability = Capability.Ready,
    private val confirm: Boolean = true,
    private val fingerprint: String? = null,
) : PackageActor {
    val frozen = mutableSetOf<String>()
    val uninstalled = mutableSetOf<String>()

    override fun capability() = cap
    override fun listApps() = catalog
    override fun enabled(pkg: String) = pkg !in frozen
    override fun fingerprint() = fingerprint
    override fun confirm(title: String, body: String) = confirm
    override fun freeze(pkg: String): ActorResult {
        frozen += pkg
        return ActorResult(true)
    }
    override fun unfreeze(pkg: String): ActorResult {
        frozen -= pkg
        return ActorResult(true)
    }
    override fun uninstall(pkg: String): ActorResult {
        uninstalled += pkg
        return ActorResult(true)
    }
    override fun clear(pkg: String) = ActorResult(true)
    override fun grant(pkg: String, permission: String) = ActorResult(true)
    override fun revoke(pkg: String, permission: String) = ActorResult(true)
    override fun install(apk: String) = ActorResult(true)
}
