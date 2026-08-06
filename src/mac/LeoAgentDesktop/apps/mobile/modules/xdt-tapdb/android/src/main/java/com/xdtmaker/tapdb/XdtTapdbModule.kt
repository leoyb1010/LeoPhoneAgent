package com.xdtmaker.tapdb

import com.taptap.sdk.core.TapTapEvent
import com.taptap.sdk.core.TapTapEventOptions
import com.taptap.sdk.core.TapTapRegion
import com.taptap.sdk.core.TapTapSdk
import com.taptap.sdk.core.TapTapSdkOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class XdtTapdbModule : Module() {
  private var initialized = false

  override fun definition() = ModuleDefinition {
    Name("XdtTapdb")

    AsyncFunction("initialize") { options: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw CodedException("ERR_TAPDB_NO_CONTEXT", "No React context for TapDB initialization.", null)
      val clientId = options["clientId"] as? String
      val clientToken = options["clientToken"] as? String
      if (clientId.isNullOrBlank() || clientToken.isNullOrBlank()) {
        throw CodedException("ERR_TAPDB_INVALID_CONFIG", "Missing TapTap client id or token.", null)
      }

      if (initialized) {
        return@AsyncFunction
      }

      val eventOptions = TapTapEventOptions.builder()
        .channel((options["channel"] as? String).orEmpty())
        .autoIAPEventEnabled(false)
        .overrideBuiltInParameters(false)
        .properties(toJsonObject(options["properties"]))
        .disableAutoLogDeviceLogin(false)
        .disableReflectionOAID(true)
        .build()

      TapTapSdk.init(
        context,
        TapTapSdkOptions(clientId, clientToken, resolveRegion(options["region"] as? String)),
        eventOptions,
      )
      initialized = true
    }

    AsyncFunction("setUserId") { userId: String ->
      if (initialized && userId.isNotBlank()) {
        TapTapEvent.setUserId(userId, JSONObject())
      }
    }

    AsyncFunction("clearUser") {
      if (initialized) {
        TapTapEvent.clearUser()
      }
    }
  }

  // tap-core 4.10.5 的 TapTapRegion 是 @IntDef 注解(CN/GLOBAL 为 Int 常量),
  // TapTapSdkOptions 第三参也是 Int region —— 故返回 Int(IntDef 仅 lint,不用注解即可编译)。
  private fun resolveRegion(value: String?): Int {
    return if (value == "global") TapTapRegion.GLOBAL else TapTapRegion.CN
  }

  private fun toJsonObject(value: Any?): JSONObject {
    val json = JSONObject()
    val map = value as? Map<*, *> ?: return json
    for ((rawKey, rawValue) in map) {
      val key = rawKey as? String ?: continue
      when (rawValue) {
        is String -> json.put(key, rawValue)
        is Number -> json.put(key, rawValue)
        is Boolean -> json.put(key, rawValue)
      }
    }
    return json
  }
}
