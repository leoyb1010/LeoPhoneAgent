//
//  AppLanguages.swift
//  MinisApp
//
//  应用内语言选择器的可选项。纯 Foundation,App 与逻辑测试共用。
//

import Foundation

struct LanguageOption: Identifiable {
    let id: String   // language code, "" = system
    let name: String  // native name
    let flag: String
}

// WP-03(1.75.0):只保留译完的中英三种。ja/ko/fr/de/ru 覆盖率约一半,切过去满屏英文夹杂,
// 已从入口下架(Info.plist CFBundleLocalizations、各自 .lproj 一并移除);Localizable.xcstrings
// 里的译文保留,补齐后把条目加回来即可。
let supportedLanguages: [LanguageOption] = [
    LanguageOption(id: "",       name: "System", flag: ""),
    LanguageOption(id: "en",     name: "English", flag: "🇺🇸"),
    LanguageOption(id: "zh-Hans", name: "简体中文", flag: "🇨🇳"),
    LanguageOption(id: "zh-Hant", name: "繁體中文", flag: "🇹🇼"),
]

extension LanguageOption {
    /// 存储的 appLanguage 不在当前可选列表里(例如下架前选过 "ja")时回到「跟随系统」,
    /// 否则选择器里一个勾都没有,界面却停在半译语言上。
    static func normalizedAppLanguage(_ stored: String) -> String {
        supportedLanguages.contains { $0.id == stored } ? stored : ""
    }
}
