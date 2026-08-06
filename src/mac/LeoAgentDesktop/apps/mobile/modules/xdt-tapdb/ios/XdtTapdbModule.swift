import ExpoModulesCore
import TapTapCoreSDK

public class XdtTapdbModule: Module {
  private var initialized = false

  public func definition() -> ModuleDefinition {
    Name("XdtTapdb")

    AsyncFunction("initialize") { (options: [String: Any]) in
      guard let clientId = options["clientId"] as? String, !clientId.isEmpty,
            let clientToken = options["clientToken"] as? String, !clientToken.isEmpty else {
        throw Exception(name: "ERR_TAPDB_INVALID_CONFIG", description: "Missing TapTap client id or token.")
      }

      if self.initialized {
        return
      }

      let sdkOptions = TapTapSdkOptions()
      sdkOptions.clientId = clientId
      sdkOptions.clientToken = clientToken
      sdkOptions.region = self.resolveRegion(options["region"] as? String)

      let eventOptions = TapTapEventOptions()
      eventOptions.channel = self.stringOption(options["channel"])
      eventOptions.overrideBuiltInParameters = false
      eventOptions.enableAutoIAPEvent = false
      eventOptions.enableAdvertiserIDCollection = false
      if let properties = options["properties"] as? [String: Any] {
        eventOptions.properties = self.sanitizeProperties(properties)
      }

      TapTapSDK.initWith(sdkOptions, otherOptions: [eventOptions])
      self.initialized = true
    }

    AsyncFunction("setUserId") { (userId: String) in
      guard self.initialized, !userId.isEmpty else {
        return
      }
      TapTapEvent.setUserID(userId)
    }

    AsyncFunction("clearUser") {
      guard self.initialized else {
        return
      }
      TapTapEvent.clearUser()
    }
  }

  private func resolveRegion(_ value: String?) -> TapTapRegionType {
    return value == "global" ? .overseas : .CN
  }

  private func stringOption(_ value: Any?) -> String {
    guard let string = value as? String else {
      return ""
    }
    return string
  }

  private func sanitizeProperties(_ raw: [String: Any]) -> [String: Any] {
    var properties: [String: Any] = [:]
    for (key, value) in raw {
      if let string = value as? String {
        properties[key] = string
      } else if let number = value as? NSNumber {
        properties[key] = number
      } else if let bool = value as? Bool {
        properties[key] = bool
      }
    }
    return properties
  }
}
