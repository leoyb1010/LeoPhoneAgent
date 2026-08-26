package com.leoyuan.leophoneagent.power.rules

import com.leoyuan.leophoneagent.power.txn.OpKind
import com.leoyuan.leophoneagent.power.txn.RiskLevel
import org.json.JSONArray
import org.json.JSONObject

data class SuccessSelector(val type: String, val equals: Boolean? = null)

data class AppRule(
    val id: String,
    val version: String,
    val source: String,
    val signature: String,
    val expiresAt: Long?,
    val packageMatch: String,
    val activity: String?,
    val window: String?,
    val selector: String?,
    val conditions: List<String>,
    val action: OpKind,
    val successSelector: SuccessSelector?,
    val risk: RiskLevel,
    val rollback: OpKind?,
)

object AppRules {
    // ponytail: 5 handwritten rules, not a GKD engine. Generalize in T3.5
    // if selectors stably hit 3 apps.
    const val BUNDLED_JSON = """
{"rules":[
{"id":"freeze","version":"1","source":"bundled","signature":"bundled","expiresAt":null,"package":"*","activity":null,"window":null,"selector":null,"conditions":["user-initiated"],"action":"freeze","successSelector":{"type":"pm-enabled","equals":false},"risk":"medium","rollback":"unfreeze"},
{"id":"unfreeze","version":"1","source":"bundled","signature":"bundled","expiresAt":null,"package":"*","activity":null,"window":null,"selector":null,"conditions":["user-initiated"],"action":"unfreeze","successSelector":{"type":"pm-enabled","equals":true},"risk":"medium","rollback":"freeze"},
{"id":"uninstall","version":"1","source":"bundled","signature":"bundled","expiresAt":null,"package":"*","activity":null,"window":null,"selector":null,"conditions":["user-initiated"],"action":"uninstall","successSelector":{"type":"pm-installed","equals":false},"risk":"always_confirm","rollback":null},
{"id":"clear","version":"1","source":"bundled","signature":"bundled","expiresAt":null,"package":"*","activity":null,"window":null,"selector":null,"conditions":["user-initiated"],"action":"clear","successSelector":{"type":"pm-exists","equals":true},"risk":"always_confirm","rollback":null},
{"id":"revoke","version":"1","source":"bundled","signature":"bundled","expiresAt":null,"package":"*","activity":null,"window":null,"selector":null,"conditions":["user-initiated"],"action":"revoke","successSelector":{"type":"pm-permission","equals":false},"risk":"always_confirm","rollback":"grant"}
]}
"""

    fun bundled(): List<AppRule> = parse(BUNDLED_JSON)

    fun parse(json: String): List<AppRule> {
        val root = JSONObject(json)
        if (root.has("bytecode") || root.has("dex") || root.has("code")) {
            error("rules payload must stay declarative")
        }
        val arr: JSONArray = root.getJSONArray("rules")
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            AppRule(
                id = o.getString("id"),
                version = o.optString("version", "1"),
                source = o.optString("source", "bundled"),
                signature = o.optString("signature", "bundled"),
                expiresAt = if (o.isNull("expiresAt")) null else o.optLong("expiresAt"),
                packageMatch = o.optString("package", "*"),
                activity = nullable(o, "activity"),
                window = nullable(o, "window"),
                selector = nullable(o, "selector"),
                conditions = o.optJSONArray("conditions")?.let { a ->
                    (0 until a.length()).map { a.getString(it) }
                } ?: emptyList(),
                action = OpKind.parse(o.getString("action")),
                successSelector = o.optJSONObject("successSelector")?.let {
                    SuccessSelector(it.optString("type"), if (it.has("equals")) it.getBoolean("equals") else null)
                },
                risk = RiskLevel.parse(o.optString("risk", "medium")),
                rollback = nullable(o, "rollback")?.let { OpKind.parse(it) },
            )
        }
    }

    fun forAction(action: OpKind, rules: List<AppRule> = bundled()): AppRule? =
        rules.firstOrNull { it.action == action }

    // Android org.json.optString(JSONObject.NULL) returns the word "null".
    private fun nullable(o: JSONObject, key: String): String? {
        if (!o.has(key) || o.isNull(key)) return null
        val v = o.getString(key)
        return v.takeIf { it.isNotBlank() && it != "null" }
    }
}
