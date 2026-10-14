import XCTest

/// 代码块配色（CodeSyntaxPalette）：8 类 token × 明暗 = 16 个颜色。
/// 读的就是 SelectableMarkdownTheme 拼动态 UIColor 用的那份十六进制数值，所以测的是上线的值。
final class CodeSyntaxPaletteTests: XCTestCase {
    // MARK: Colour maths (WCAG 2.x relative luminance; OKLab)

    private func channels(_ hex: UInt32) -> (r: Double, g: Double, b: Double) {
        (Double((hex >> 16) & 0xFF) / 255, Double((hex >> 8) & 0xFF) / 255, Double(hex & 0xFF) / 255)
    }

    private func linear(_ value: Double) -> Double {
        value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }

    private func luminance(_ hex: UInt32) -> Double {
        let c = channels(hex)
        return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
    }

    private func contrastRatio(_ a: UInt32, _ b: UInt32) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private func oklch(_ hex: UInt32) -> (lightness: Double, chroma: Double, hue: Double) {
        let c = channels(hex)
        let (r, g, b) = (linear(c.r), linear(c.g), linear(c.b))
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
        let a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
        let bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        var hue = atan2(bb, a) * 180 / .pi
        if hue < 0 { hue += 360 }
        return (lightness, (a * a + bb * bb).squareRoot(), hue)
    }

    private func name(_ hex: UInt32) -> String { String(format: "#%06X", hex) }

    // MARK: Tests

    func testTheHelperAgreesWithKnownWCAGValues() {
        XCTAssertEqual(contrastRatio(0x000000, 0xFFFFFF), 21, accuracy: 0.001)
        XCTAssertEqual(contrastRatio(0x777777, 0x777777), 1, accuracy: 0.001)
        // 公认值：#767676 在白底上刚好 4.54:1
        XCTAssertEqual(contrastRatio(0x767676, 0xFFFFFF), 4.54, accuracy: 0.01)
    }

    func testThereAreEightTokenClassesAndSixteenColours() {
        XCTAssertEqual(LeoSyntaxToken.allCases.count, 8)
        var colours = Set<String>()
        for token in LeoSyntaxToken.allCases {
            for dark in [false, true] {
                colours.insert("\(token)-\(dark)-\(LeoCodePalette.rgb(for: token, dark: dark))")
            }
        }
        XCTAssertEqual(colours.count, 16)
    }

    func testBackgroundsAreTheNeutralGreysOfTheDesignSystem() {
        XCTAssertEqual(LeoCodePalette.lightBackground, 0xF4F4F5)
        XCTAssertEqual(LeoCodePalette.darkBackground, 0x1C1C1E)
        XCTAssertEqual(LeoCodePalette.background(dark: false), 0xF4F4F5)
        XCTAssertEqual(LeoCodePalette.background(dark: true), 0x1C1C1E)
    }

    func testEveryOneOfTheSixteenColoursMeetsAAContrastOnItsOwnBackground() {
        for dark in [false, true] {
            let background = LeoCodePalette.background(dark: dark)
            for token in LeoSyntaxToken.allCases {
                let colour = LeoCodePalette.rgb(for: token, dark: dark)
                let ratio = contrastRatio(colour, background)
                XCTAssertGreaterThanOrEqual(
                    ratio, 4.5,
                    "\(token) \(dark ? "dark" : "light") \(name(colour)) on \(name(background)) is only \(ratio):1"
                )
            }
        }
    }

    func testDefaultTextAlsoReadsOnBothBackgrounds() {
        // 默认文字用 label：浅色黑、深色白。
        XCTAssertGreaterThanOrEqual(contrastRatio(0x000000, LeoCodePalette.lightBackground), 7)
        XCTAssertGreaterThanOrEqual(contrastRatio(0xFFFFFF, LeoCodePalette.darkBackground), 7)
    }

    func testTokenColoursShareOneLightnessPerAppearance() {
        for dark in [false, true] {
            let lightness = LeoSyntaxToken.allCases.map { oklch(LeoCodePalette.rgb(for: $0, dark: dark)).lightness }
            let spread = (lightness.max() ?? 0) - (lightness.min() ?? 0)
            XCTAssertLessThanOrEqual(spread, 0.02, "\(dark ? "dark" : "light") OKLab L spread \(spread)")
        }
        // 深色整体比浅色亮，才能在各自的底色上保持对比度。
        let lightL = oklch(LeoCodePalette.rgb(for: .keyword, dark: false)).lightness
        let darkL = oklch(LeoCodePalette.rgb(for: .keyword, dark: true)).lightness
        XCTAssertGreaterThan(darkL, lightL)
    }

    func testTokensAreToldApartByHueNotByBrightness() {
        let chromatic: [LeoSyntaxToken] = [.keyword, .string, .number, .type, .function, .attribute]
        for dark in [false, true] {
            let hues = chromatic.map { token -> (LeoSyntaxToken, Double) in
                let value = oklch(LeoCodePalette.rgb(for: token, dark: dark))
                XCTAssertGreaterThanOrEqual(value.chroma, 0.07, "\(token) must be a real colour")
                return (token, value.hue)
            }
            for i in hues.indices {
                for j in hues.indices where j > i {
                    let raw = abs(hues[i].1 - hues[j].1)
                    let distance = min(raw, 360 - raw)
                    XCTAssertGreaterThanOrEqual(
                        distance, 30,
                        "\(hues[i].0) and \(hues[j].0) are only \(distance)° apart (\(dark ? "dark" : "light"))"
                    )
                }
            }
        }
    }

    func testCommentsAndPunctuationAreQuietNeutrals() {
        for dark in [false, true] {
            for token in [LeoSyntaxToken.comment, .punctuation] {
                let value = oklch(LeoCodePalette.rgb(for: token, dark: dark))
                XCTAssertLessThanOrEqual(value.chroma, 0.04, "\(token) should stay a muted grey")
            }
        }
    }

    func testAllEightColoursAreDistinctInEachAppearance() {
        for dark in [false, true] {
            let colours = Set(LeoSyntaxToken.allCases.map { LeoCodePalette.rgb(for: $0, dark: dark) })
            XCTAssertEqual(colours.count, 8)
        }
    }
}
