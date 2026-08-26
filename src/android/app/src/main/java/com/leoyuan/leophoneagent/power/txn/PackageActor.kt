package com.leoyuan.leophoneagent.power.txn

data class InstalledApp(val pkg: String, val label: String)

data class ActorResult(val ok: Boolean, val message: String = "")

enum class Capability { Ready, Denied, ServiceDown, NeedGrant }

interface PackageActor {
    fun capability(): Capability
    fun listApps(): List<InstalledApp>
    fun enabled(pkg: String): Boolean?
    fun fingerprint(): String? = null
    fun confirm(title: String, body: String): Boolean = true
    fun freeze(pkg: String): ActorResult
    fun unfreeze(pkg: String): ActorResult
    fun uninstall(pkg: String): ActorResult
    fun clear(pkg: String): ActorResult
    fun grant(pkg: String, permission: String): ActorResult
    fun revoke(pkg: String, permission: String): ActorResult
    fun install(apk: String): ActorResult
}

object NoopPackageActor : PackageActor {
    override fun capability(): Capability = Capability.Denied
    override fun listApps(): List<InstalledApp> = emptyList()
    override fun enabled(pkg: String): Boolean? = null
    override fun freeze(pkg: String) = ActorResult(false, "standard")
    override fun unfreeze(pkg: String) = ActorResult(false, "standard")
    override fun uninstall(pkg: String) = ActorResult(false, "standard")
    override fun clear(pkg: String) = ActorResult(false, "standard")
    override fun grant(pkg: String, permission: String) = ActorResult(false, "standard")
    override fun revoke(pkg: String, permission: String) = ActorResult(false, "standard")
    override fun install(apk: String) = ActorResult(false, "standard")
}
