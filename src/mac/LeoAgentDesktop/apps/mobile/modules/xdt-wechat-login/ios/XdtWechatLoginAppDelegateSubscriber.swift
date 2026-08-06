import ExpoModulesCore

/** Forwards WeChat custom-scheme and universal-link responses to the shared SDK delegate. */
public class XdtWechatLoginAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return XdtWechatAuthCoordinator.shared.handleOpen(url)
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    return XdtWechatAuthCoordinator.shared.handleUniversalLink(userActivity)
  }
}
