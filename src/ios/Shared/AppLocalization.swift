//
//  AppLocalization.swift
//  MinisApp
//
//  WP-40(1.75.0):应用内切语言即时生效。移植自 OpenMinis v1.14
//  `Shared/AppLocalization.swift`([T-ios-inapp-language-string-localized])。
//
//  问题
//  ----
//  原来只靠 swizzle `Bundle.localizedString(forKey:value:table:)`(见下方
//  `enableLanguageOverride`)让应用内语言立即生效。`Text("…")` 和 UIKit 走这个 ObjC
//  入口,能跟着切;但 `String(localized:)` 在 Foundation 内部直接查表,根本不经过它
//  (上游实测:swizzle、换 isa、改 preferredLocalizations 三种拦截全部绕过)。
//  `AppleLanguages` 只在下次进程启动才生效。结果是切完语言,一半界面变了、一半要重启。
//
//  做法
//  ----
//  唯一有文档保证的入口是 `String(localized:bundle:)`:显式传入当前语言的 `.lproj`
//  bundle。所有面向用户的 `String(localized:)` 改走 `AppLocalized(...)`,它读
//  `AppBundle.current`——应用内选了语言时是那个 `.lproj`,否则就是 `Bundle.main`,
//  行为与原来完全一致。配合 `MinisApp` 根视图的 `.id(appLanguage)` 重建,切语言后
//  当前页面文字立即换掉,不必重启。
//
//  扩展进程(小组件、分享、FileProvider、手表)不在这里:它们读不到 App 进程的
//  override,小组件另有 `LeoWidgetLanguage`。
//

import Foundation
import ObjectiveC

// MARK: - Bundle Language Override

extension Bundle {
    nonisolated(unsafe) private static var overrideBundleKey: UInt8 = 0
    nonisolated(unsafe) private static var didSwizzle = false

    /// The language-specific `.lproj` bundle currently in use, or `nil` for system default.
    var languageBundle: Bundle? {
        get { objc_getAssociatedObject(self, &Self.overrideBundleKey) as? Bundle }
        set { objc_setAssociatedObject(self, &Self.overrideBundleKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    /// Call once at launch to swizzle `localizedString(forKey:value:table:)` so `Text("…")`
    /// and UIKit follow the in-app language. Idempotent: a second exchange would undo the first.
    static func enableLanguageOverride() {
        guard !didSwizzle else { return }
        didSwizzle = true
        let original = class_getInstanceMethod(Bundle.self, #selector(localizedString(forKey:value:table:)))!
        let swizzled = class_getInstanceMethod(Bundle.self, #selector(overrideLocalizedString(forKey:value:table:)))!
        method_exchangeImplementations(original, swizzled)
    }

    @objc private func overrideLocalizedString(forKey key: String, value: String?, table tableName: String?) -> String {
        if self == Bundle.main, let bundle = languageBundle {
            return bundle.overrideLocalizedString(forKey: key, value: value, table: tableName)
        }
        return overrideLocalizedString(forKey: key, value: value, table: tableName) // calls original (swizzled)
    }

    /// The `.lproj` bundle for `code` inside `host`, or nil when the app ships no such language.
    static func languageBundle(for code: String?, in host: Bundle = .main) -> Bundle? {
        guard let code, !code.isEmpty,
              let path = host.path(forResource: code, ofType: "lproj") else { return nil }
        return Bundle(path: path)
    }

    /// 应用内选定的语言代码;nil = 跟随系统。
    nonisolated(unsafe) private(set) static var overrideLanguageCode: String?

    /// Sets the override language. Pass `nil` or `""` to revert to system language.
    static func setLanguage(_ code: String?) {
        guard let bundle = languageBundle(for: code) else {
            Bundle.main.languageBundle = nil
            overrideLanguageCode = nil
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
            return
        }
        Bundle.main.languageBundle = bundle
        overrideLanguageCode = code
        UserDefaults.standard.set([code!], forKey: "AppleLanguages")
    }
}

// MARK: - Lookup

/// The bundle localized lookups should read from: the in-app override `.lproj` when the
/// user picked a language in Settings, `Bundle.main` otherwise (system language applies).
enum AppBundle {
    static var current: Bundle {
        Bundle.main.languageBundle ?? Bundle.main
    }
}

/// Localized string that follows the in-app language override. Drop-in replacement for
/// `String(localized:)` anywhere the result is shown to the user. `Text("…")` does not
/// need it — SwiftUI's `Text` goes through the swizzled `localizedString`.
func AppLocalized(_ key: String.LocalizationValue, comment: StaticString? = nil) -> String {
    String(localized: key, bundle: AppBundle.current, comment: comment)
}

/// `LocalizedStringResource` 版本(App Intents 会造这种值)。故意用 `resource:` 标签而不是重载:
/// 字符串字面量既能当 `LocalizationValue` 也能当 `LocalizedStringResource`,同名重载时编译器会挑
/// 后者,于是所有 `AppLocalized("…")` 静默绕过 override —— 逻辑测试实测踩过。
/// resource 自带 bundle 引用改不了,只能把 `locale` 换成应用内语言,让查表落在对应 `.lproj`。
func AppLocalized(resource: LocalizedStringResource) -> String {
    guard let code = Bundle.overrideLanguageCode else { return String(localized: resource) }
    var localized = resource
    localized.locale = Locale(identifier: code)
    return String(localized: localized)
}
