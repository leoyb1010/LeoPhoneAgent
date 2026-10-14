//
//  CodeSyntaxPalette.swift
//
//  代码块的配色：8 类 token × 明暗各一套，外加两种底色。只放十六进制数值（Foundation），
//  `SelectableMarkdownTheme` 用它们拼动态 UIColor；对比度测试直接读这里，所以测的就是上线的值。
//
//  取色方法：在 OKLCH 里让同一外观下的 8 个颜色明度（L）相同，只靠色相区分，
//  各自在对应底色上的 WCAG 对比度都 ≥ 4.5:1（见 CodeSyntaxPaletteTests）。
//    浅色 L≈0.52，底色 #F4F4F5；深色 L≈0.76，底色 #1C1C1E。
//  六类有彩度的色相（C≈0.09–0.15，超出 sRGB 色域的按色域降低 C）：
//    关键字 洋红 350° · 字符串 绿 150° · 数字 橙 55° · 类型 青 200° · 函数 蓝 260° · 属性 紫 300°
//  运算符/标点与注释是低彩度的灰：标点 石板蓝 255°（C≈0.03），注释 暖灰 100°（C≈0.012）。
//  「同明度、只靠色相区分」的思路取自 MarkdownView 的 MarkdownTheme+Code.swift（MIT，见
//  THIRD_PARTY_LICENSES.md）；那套浅色在 #F4F4F5 上只有约 2.8–3.2:1（深色倒是 ≥ 7:1），达不到 4.5:1，所以数值是按本项目的底色重算的。
//

import Foundation

enum LeoCodePalette {
    /// 代码块底色：浅色约 #F4F4F5，深色约 #1C1C1E（与 LeoTheme 的中性灰阶一致）。
    static let lightBackground: UInt32 = 0xF4F4F5
    static let darkBackground: UInt32 = 0x1C1C1E

    static func background(dark: Bool) -> UInt32 {
        dark ? darkBackground : lightBackground
    }

    /// 某类 token 在某个外观下的 0xRRGGBB。
    static func rgb(for token: LeoSyntaxToken, dark: Bool) -> UInt32 {
        let pair: (light: UInt32, dark: UInt32)
        switch token {
        case .keyword: pair = (0xA53C75, 0xF786BE)
        case .string: pair = (0x1D7D3E, 0x6FC884)
        case .number: pair = (0x9F5102, 0xF49752)
        case .comment: pair = (0x6A6961, 0xB3B1A9)
        case .type: pair = (0x02787D, 0x46C6CD)
        case .function: pair = (0x3065BE, 0x82B2FF)
        case .attribute: pair = (0x7555A8, 0xBE9DF7)
        case .punctuation: pair = (0x5E6A7A, 0xA5B2C4)
        }
        return dark ? pair.dark : pair.light
    }
}
