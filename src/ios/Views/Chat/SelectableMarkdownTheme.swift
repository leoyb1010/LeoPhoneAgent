import UIKit

/// [T-inline-code-dark-bg-ios] Inline-code span background, shared by the
/// theme and the layout manager's fillBackgroundRectArray (the actual paint
/// site) so the two can never drift. Light stays EXACTLY .systemGray6
/// (#F2F2F7); dark lifts to #3A3A3C (systemGray4's dark value) because
/// systemGray6 resolves too close to the near-black chat background in dark.
let minisInlineCodeBackgroundColor = UIColor { traits in
    traits.userInterfaceStyle == .dark
        ? UIColor(red: 0x3A / 255.0, green: 0x3A / 255.0, blue: 0x3C / 255.0, alpha: 1)
        : .systemGray6
}

/// [T-codeblock-leo-theme] 0xRRGGBB → 不透明 UIColor（sRGB）。
private extension UIColor {
    convenience init(leoRGB hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255.0,
                  green: CGFloat((hex >> 8) & 0xFF) / 255.0,
                  blue: CGFloat(hex & 0xFF) / 255.0,
                  alpha: 1)
    }
}

/// [T-codeblock-leo-theme] 代码块底色：浅 #F4F4F5 / 深 #1C1C1E。数值在 `LeoCodePalette`，
/// 对比度测试读的是同一份，所以测的就是这里用的。动态色：切换外观时由系统在绘制时重新解析。
private let leoCodeBlockBackgroundColor = UIColor { traits in
    UIColor(leoRGB: LeoCodePalette.background(dark: traits.userInterfaceStyle == .dark))
}

/// [T-codeblock-leo-theme] 8 类 token 的动态色表，只建一次、按 `LeoSyntaxToken.rawValue` 取：
/// 同一个 UIColor 实例也让相邻属性段更容易被 NSAttributedString 合并。
private let leoSyntaxColors: [UIColor] = LeoSyntaxToken.allCases.map { token in
    UIColor { traits in
        UIColor(leoRGB: LeoCodePalette.rgb(for: token, dark: traits.userInterfaceStyle == .dark))
    }
}

/// 全 App 唯一的强调色：AccentColor 资源（浅 #2A8282 / 深 #2E9C9C），与 `LeoTheme.ColorToken.accent` 同源。
/// 直接用 UIKit 取，因为引用条是在 draw(_:) 里 `.cgColor` 出来的，要保证按当前外观解析。
private let leoAccentUIColor: UIColor = UIColor(named: "AccentColor") ?? .systemTeal

/// Mirrors the chat Markdown theme using UIKit types.
struct SelectableMarkdownTheme {
    let baseFontSize: CGFloat
    /// [T-codeblock-leo-theme] LeoTheme 的「字段」圆角（12）：代码块嵌在 18 的消息气泡里，
    /// 比 16 的内容面圆角更收敛；原来写死的 8 与整套圆角脱节。
    let codeBlockCornerRadius: CGFloat = LeoTheme.Radius.field
    let inlineCodeCornerRadius: CGFloat = 5

    init(baseFontSize: CGFloat? = nil) {
        self.baseFontSize = baseFontSize ?? 16.5
    }

    var baseFont: UIFont { .systemFont(ofSize: baseFontSize) }
    var labelColor: UIColor { .label }
    var secondaryLabelColor: UIColor { .secondaryLabel }
    /// [T-codeblock-leo-theme] 原来是 systemOrange，与 LeoTheme 的青绿强调色脱节。
    var accentColor: UIColor { leoAccentUIColor }
    /// [output-render] Links take the app's single accent (teal), with a soft underline in the
    /// same hue, instead of system blue + a full-strength underline that read as a second brand
    /// color in every reply.
    var linkColor: UIColor { leoAccentUIColor }
    var linkUnderlineColor: UIColor { leoAccentUIColor.withAlphaComponent(0.4) }
    /// List bullets and open task boxes: decoration, so secondary (numbers stay label).
    var listMarkerColor: UIColor { .secondaryLabel }
    /// [T-codeblock-leo-theme] 中性代码块：浅 #F4F4F5 / 深 #1C1C1E，不再是浅色模式下也纯黑的底。
    var codeBlockBackground: UIColor { leoCodeBlockBackgroundColor }
    /// 代码默认文字（没有被词法高亮着色的部分）：label，浅色黑、深色白。
    var codeBlockTextColor: UIColor { .label }
    /// 代码块里的次要元素（语言标签、复制按钮）：原来是写死的半透明白，放到浅色底上会看不见。
    var codeBlockChromeColor: UIColor { .secondaryLabel }
    var inlineCodeBackground: UIColor { minisInlineCodeBackgroundColor }
    /// [T-codeblock-leo-theme] 行内代码：正文色的小胶囊（底色见 `minisInlineCodeBackgroundColor`），
    /// 不再用 systemOrange——等宽字体 + 灰底已足够把它和正文区分开。
    var inlineCodeColor: UIColor { .label }
    /// [T-codeblock-leo-theme] 引用条：青绿强调色 60%（原 systemOrange 50%）。不用 separator：
    /// 深色下 separator 叠在近黑底上只剩 1.5:1，3pt 的条几乎看不见。
    var blockquoteBarColor: UIColor { leoAccentUIColor.withAlphaComponent(0.6) }

    /// [T-codeblock-leo-theme] 词法高亮的 token 颜色（明暗各一套，同明度、靠色相区分，对比度 ≥ 4.5:1）。
    func syntaxColor(for token: LeoSyntaxToken) -> UIColor { leoSyntaxColors[token.rawValue] }
    /// [output-render] Hairlines between rows and around the table: the system separator
    /// (adapts to light/dark) rather than 25 % label, which drew a heavy grid.
    var tableBorderColor: UIColor { .separator }
    /// Header row fill — the one cue (with semibold) that separates header from body.
    var tableHeaderBackground: UIColor { .tertiarySystemFill }

    func headingFont(level: Int) -> UIFont {
        let size: CGFloat
        let weight: UIFont.Weight
        switch level {
        case 1: size = baseFontSize * 1.5; weight = .bold
        case 2: size = baseFontSize * 1.3; weight = .bold
        case 3: size = baseFontSize * 1.15; weight = .semibold
        case 5: size = baseFontSize * 0.875; weight = .semibold
        case 6: size = baseFontSize * 0.85; weight = .semibold
        default: size = baseFontSize; weight = .semibold
        }
        return .systemFont(ofSize: size, weight: weight)
    }

    var inlineCodeFont: UIFont {
        let size = baseFontSize * 0.845
        if let menlo = UIFont(name: "Menlo", size: size) {
            let descriptor = menlo.fontDescriptor.addingAttributes([
                .cascadeList: [UIFontDescriptor(fontAttributes: [.name: "PingFang SC"])]
            ])
            return UIFont(descriptor: descriptor, size: size)
        }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    var codeBlockFont: UIFont {
        // [output-render] Capped at 22 pt: at the largest accessibility text sizes a code line
        // at 0.85× body (28 pt) showed ~15 characters before scrolling.
        let size = min(baseFontSize * 0.85, 22)
        if let menlo = UIFont(name: "Menlo", size: size) {
            let descriptor = menlo.fontDescriptor.addingAttributes([
                .cascadeList: [UIFontDescriptor(fontAttributes: [.name: "PingFang SC"])]
            ])
            return UIFont(descriptor: descriptor, size: size)
        }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }
}
