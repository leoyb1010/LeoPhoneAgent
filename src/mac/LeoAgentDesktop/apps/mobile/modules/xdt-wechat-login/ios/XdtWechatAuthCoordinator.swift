import ExpoModulesCore

#if targetEnvironment(simulator)
/**
 * WechatOpenSDK 2.0.5 没有 arm64-simulator 切片。Simulator 只保留稳定的不可用语义，
 * 真机编译继续走下方真实 SDK，避免为本地调试牺牲生产微信登录。
 */
final class XdtWechatAuthCoordinator {
  static let shared = XdtWechatAuthCoordinator()

  func isInstalled() -> Bool {
    return false
  }

  func request(options: [String: Any], promise: Promise) {
    promise.reject(
      "ERR_WECHAT_UNAVAILABLE_ON_SIMULATOR",
      "WeChat login is unavailable in the iOS Simulator."
    )
  }

  func handleOpen(_ url: URL) -> Bool {
    return false
  }

  func handleUniversalLink(_ userActivity: NSUserActivity) -> Bool {
    return false
  }

  func cancel() {}
}
#else
import WechatOpenSDK

/** Process-wide WeChat delegate shared by the Expo module and app-delegate subscriber. */
final class XdtWechatAuthCoordinator: NSObject, WXApiDelegate {
  static let shared = XdtWechatAuthCoordinator()

  private var pendingPromise: Promise?
  private var expectedState: String?

  func isInstalled() -> Bool {
    return WXApi.isWXAppInstalled()
  }

  func request(options: [String: Any], promise: Promise) {
    guard let appId = options["appId"] as? String, !appId.isEmpty else {
      promise.reject("ERR_WECHAT_INVALID_APP_ID", "Missing WeChat appId.")
      return
    }
    guard let universalLink = options["universalLink"] as? String, !universalLink.isEmpty else {
      promise.reject("ERR_WECHAT_INVALID_UNIVERSAL_LINK", "Missing WeChat universal link.")
      return
    }
    guard let state = options["state"] as? String, !state.isEmpty else {
      promise.reject("ERR_WECHAT_INVALID_STATE", "Missing WeChat request state.")
      return
    }
    guard pendingPromise == nil else {
      promise.reject("ERR_WECHAT_IN_PROGRESS", "WeChat login is already in progress.")
      return
    }
    guard WXApi.registerApp(appId, universalLink: universalLink) else {
      promise.reject("ERR_WECHAT_REGISTER_FAILED", "Could not register the WeChat application.")
      return
    }

    pendingPromise = promise
    expectedState = state
    let request = SendAuthReq()
    request.scope = (options["scope"] as? String) ?? "snsapi_userinfo"
    request.state = state
    WXApi.send(request) { success in
      if !success {
        self.rejectPending(code: "ERR_WECHAT_LAUNCH_FAILED", message: "Could not open WeChat.")
      }
    }
  }

  func handleOpen(_ url: URL) -> Bool {
    return WXApi.handleOpen(url, delegate: self)
  }

  func handleUniversalLink(_ userActivity: NSUserActivity) -> Bool {
    return WXApi.handleOpenUniversalLink(userActivity, delegate: self)
  }

  func cancel() {
    rejectPending(
      code: "ERR_WECHAT_CANCELLED_BY_CLIENT",
      message: "WeChat authorization was cancelled by Cindy."
    )
  }

  func onReq(_ request: BaseReq) {}

  func onResp(_ response: BaseResp) {
    guard let auth = response as? SendAuthResp else { return }
    guard auth.state == expectedState else {
      rejectPending(code: "ERR_WECHAT_STATE_MISMATCH", message: "WeChat state verification failed.")
      return
    }
    // SDK 的 errCode 是 Int32,WXSuccess / WXErrCodeUserCancel 桥进 Swift 是 WXErrCode 枚举,须取 rawValue 比较。
    guard auth.errCode == WXSuccess.rawValue, let code = auth.code, !code.isEmpty else {
      let errorCode = auth.errCode == WXErrCodeUserCancel.rawValue
        ? "ERR_WECHAT_CANCELLED"
        : "ERR_WECHAT_LOGIN_FAILED"
      rejectPending(code: errorCode, message: "WeChat authorization did not complete.")
      return
    }
    let promise = pendingPromise
    pendingPromise = nil
    expectedState = nil
    promise?.resolve(["code": code])
  }

  private func rejectPending(code: String, message: String) {
    let promise = pendingPromise
    pendingPromise = nil
    expectedState = nil
    promise?.reject(code, message)
  }
}
#endif
