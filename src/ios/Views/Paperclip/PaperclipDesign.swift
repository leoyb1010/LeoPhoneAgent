import SwiftUI
import UIKit

// MARK: - 状态语义色

enum PaperclipStatusStyle {
    /// 进行中 accent、受阻 warning、已完成 success、失败 destructive、取消 secondary。
    static func color(_ status: String) -> Color {
        switch status {
        case "in_progress", "running", "queued": return LeoTheme.ColorToken.accent
        case "in_review", "pending": return Color(uiColor: .systemIndigo)
        case "blocked", "revision_requested": return LeoTheme.ColorToken.warning
        case "done", "succeeded", "approved": return LeoTheme.ColorToken.success
        case "failed", "timed_out", "error", "rejected": return LeoTheme.ColorToken.destructive
        default: return LeoTheme.ColorToken.secondaryText
        }
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "in_progress": return "circle.dotted.circle"
        case "in_review": return "eye.circle"
        case "blocked": return "exclamationmark.octagon"
        case "done": return "checkmark.circle.fill"
        case "cancelled": return "xmark.circle"
        case "todo": return "circle"
        default: return "circle.dashed"
        }
    }
}

/// 带语义色的状态胶囊；文字就是中文状态，便于朗读与界面测试定位。
struct PaperclipStatusCapsule: View {
    let status: String
    var compact = false

    var body: some View {
        let color = PaperclipStatusStyle.color(status)
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(PaperclipLabels.status(status))
                .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, compact ? 7 : 9)
        .padding(.vertical, compact ? 3 : 4)
        .background(color.opacity(0.13), in: Capsule())
    }
}

// MARK: - 头像

/// 头像内存缓存：按配置与路径键控；失败的路径 5 分钟内不重试。
/// 以前失败后整个运行期都不再重试，一次网络抖动就让头像一直显示占位字母。
@MainActor
final class PaperclipAvatarCache {
    static let shared = PaperclipAvatarCache()
    private var images: [String: UIImage] = [:]
    private var failed: [String: Date] = [:]
    static let failureRetryInterval: TimeInterval = 300
    private var inflight: [String: Task<UIImage?, Never>] = [:]

    func cached(client: PaperclipClient, path: String) -> UIImage? { images[key(client, path)] }

    func image(client: PaperclipClient, path: String) async -> UIImage? {
        let key = key(client, path)
        if let image = images[key] { return image }
        if let at = failed[key], Date().timeIntervalSince(at) < Self.failureRetryInterval { return nil }
        if let running = inflight[key] { return await running.value }
        let task = Task { @MainActor () -> UIImage? in
            guard let data = try? await client.avatarData(path: path) else { return nil }
            return UIImage(data: data)
        }
        inflight[key] = task
        let image = await task.value
        inflight[key] = nil
        if let image {
            if images.count > 200 { images.removeAll() }
            images[key] = image
            failed[key] = nil
        } else { failed[key] = Date() }
        return image
    }

    private func key(_ client: PaperclipClient, _ path: String) -> String { client.profile.id.uuidString + path }
}

/// 智能体/成员头像：同源预设 PNG，加载失败或没有头像时用首字母圆形占位。
struct PaperclipAvatar: View {
    let client: PaperclipClient?
    let path: String?
    let name: String
    var size: CGFloat = 24
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().interpolation(.high).scaledToFill()
            } else {
                Circle().fill(Self.tint(for: name).opacity(0.18))
                Text(Self.initial(name))
                    .font(.system(size: size * 0.46, weight: .semibold, design: .rounded))
                    .foregroundStyle(Self.tint(for: name))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
        .accessibilityHidden(true)
        .task(id: path) {
            guard let client, let path else { image = nil; return }
            if let cached = PaperclipAvatarCache.shared.cached(client: client, path: path) { image = cached; return }
            image = await PaperclipAvatarCache.shared.image(client: client, path: path)
        }
    }

    static func initial(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    /// [F6] 青绿与灰阶的哈希配色：同一个名字永远同一个颜色，整体落在本机会话
    /// 列表的色系里，不再是一套彩虹色（看起来像另一个产品）。
    static let palette: [Color] = [
        LeoTheme.ColorToken.accent,
        Color(uiColor: .systemTeal),
        Color(uiColor: .systemGray),
        Color(uiColor: .systemGray2),
        LeoTheme.ColorToken.accent.opacity(0.7),
        Color(uiColor: .secondaryLabel)
    ]

    static func paletteIndex(for name: String) -> Int {
        let sum = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return sum % palette.count
    }

    static func tint(for name: String) -> Color { palette[paletteIndex(for: name)] }
}

// MARK: - Markdown

/// 主 App 注入端侧对话同款 SelectableMarkdownView；独立验证宿主使用下方原生回退渲染。
struct PaperclipMarkdownRenderer {
    let render: @MainActor (_ markdown: String, _ streaming: Bool) -> AnyView
}

private struct PaperclipMarkdownRendererKey: EnvironmentKey {
    static let defaultValue: PaperclipMarkdownRenderer? = nil
}

extension EnvironmentValues {
    var paperclipMarkdownRenderer: PaperclipMarkdownRenderer? {
        get { self[PaperclipMarkdownRendererKey.self] }
        set { self[PaperclipMarkdownRendererKey.self] = newValue }
    }
}

struct PaperclipMarkdown: View {
    let text: String
    var streaming = false
    @Environment(\.paperclipMarkdownRenderer) private var renderer

    var body: some View {
        if let renderer {
            renderer.render(text, streaming)
        } else {
            PaperclipFallbackMarkdown(text: text)
        }
    }
}

/// 原生回退：标题、列表、引用、代码块分块渲染，行内语法用 AttributedString。
struct PaperclipFallbackMarkdown: View {
    let text: String

    private enum Block: Hashable {
        case heading(String, Int), paragraph(String), code(String), quote(String), bullet(String, String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let lines = code { result.append(.code(lines.joined(separator: "\n"))); code = nil }
                else { flush(); code = [] }
                continue
            }
            if code != nil { code?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if let level = line.firstIndex(where: { $0 != "#" }).map({ line.distance(from: line.startIndex, to: $0) }),
               (1...4).contains(level), line.dropFirst(level).first == " " {
                flush(); result.append(.heading(String(line.dropFirst(level + 1)), level)); continue
            }
            if line.hasPrefix("> ") { flush(); result.append(.quote(String(line.dropFirst(2)))); continue }
            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flush(); result.append(.bullet("•", String(line.dropFirst(2)))); continue
            }
            if let dot = line.firstIndex(of: "."), line[..<dot].allSatisfy(\.isNumber), !line[..<dot].isEmpty,
               line[line.index(after: dot)...].hasPrefix(" ") {
                flush(); result.append(.bullet(String(line[...dot]), String(line[line.index(dot, offsetBy: 2)...]))); continue
            }
            paragraph.append(raw)
        }
        if let lines = code { result.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return result
    }

    private func inline(_ value: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: value, options: options) { return Text(attributed) }
        return Text(value)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let value, let level):
                    inline(value).font(level <= 2 ? .title3.weight(.semibold) : .headline)
                case .paragraph(let value):
                    inline(value).font(.body).lineSpacing(3)
                case .code(let value):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(value).font(.system(.footnote, design: .monospaced)).padding(12)
                    }
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field))
                case .quote(let value):
                    HStack(spacing: 10) {
                        Capsule().fill(LeoTheme.ColorToken.separator).frame(width: 3)
                        inline(value).font(.body).foregroundStyle(.secondary)
                    }.fixedSize(horizontal: false, vertical: true)
                case .bullet(let marker, let value):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).font(.body).foregroundStyle(.secondary)
                        inline(value).font(.body).lineSpacing(3)
                    }
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 动效

/// 运行中卡片的对角流光：已提升为全 App 共用的 LeoShimmer（Views/Components/LeoShimmer.swift）。
typealias PaperclipShimmer = LeoShimmer

/// 实时状态的小圆点：实时通道已连接时呼吸，轮询时静止灰色。
struct PaperclipLiveBadge: View {
    let state: PaperclipLiveConnection.State?

    private var connected: Bool { state == .open }
    private var label: String {
        switch state {
        case .open?: return "实时"
        case .verifying?, .connecting?: return "连接中"
        case .waiting?: return "重连中"
        default: return "定时同步"
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(connected ? LeoTheme.ColorToken.success : LeoTheme.ColorToken.tertiaryText)
                .frame(width: 6, height: 6)
                .leoPulse(active: connected)
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("paperclip.liveBadge")
    }
}

// MARK: - 时间显示

enum PaperclipTimeText {
    static func relative(_ value: String?, now: Date = Date()) -> String? {
        guard let date = PaperclipDates.parse(value) else { return nil }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "昨天 " + date.formatted(date: .omitted, time: .shortened) }
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        let sameYear = Calendar.current.component(.year, from: now) == parts.year
        return (sameYear ? "" : "\(parts.year ?? 0)年") + "\(parts.month ?? 0)月\(parts.day ?? 0)日"
    }

    static func short(_ value: String?) -> String? {
        guard let date = PaperclipDates.parse(value) else { return nil }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

// MARK: - 输入栏

/// 与端侧首页、对话同一个外壳（LeoComposerChrome，无业务依赖）：上方附加控件、多行输入、圆形发送键。
struct PaperclipComposerBar<Accessory: View>: View {
    @Binding var text: String
    var focus: FocusState<Bool>.Binding
    let placeholder: String
    let fieldIdentifier: String
    let sendIdentifier: String
    let sendLabel: String
    let busy: Bool
    let canSend: Bool
    let retry: Bool
    let fieldDisabled: Bool
    let onSend: () -> Void
    @ViewBuilder var accessory: () -> Accessory
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            accessory()
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .textFieldStyle(.plain)
                    .focused(focus)
                    .disabled(fieldDisabled)
                    .padding(.vertical, 7)
                    .padding(.leading, 6)
                    .frame(minHeight: 36)
                    .accessibilityIdentifier(fieldIdentifier)
                LeoComposerSendButton(canSend: canSend, busy: busy,
                                      systemImage: retry ? "arrow.clockwise" : "arrow.up",
                                      label: Text(sendLabel), identifier: sendIdentifier, action: onSend)
            }
        }
        .padding(.horizontal, LeoComposerMetrics.horizontalPadding)
        .padding(.vertical, LeoComposerMetrics.verticalPadding)
        .leoComposerChrome()
        .padding(.horizontal, LeoComposerMetrics.outerPadding)
        .padding(.bottom, 6)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: canSend)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: busy)
    }
}

/// 输入栏上方的小胶囊按钮（执行者、补充说明、待核对提示）。
struct PaperclipChip: View {
    let title: String
    let systemImage: String
    var tint: Color = .primary

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage).font(.system(size: 12, weight: .semibold))
            Text(title).font(.footnote.weight(.semibold)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
        // [F6] 底色走 LeoTheme.surface，与本机状态卡、设置卡片同一个 token。
        .background(LeoTheme.ColorToken.surface, in: Capsule())
        .contentShape(Capsule())
    }
}

/// 内联提示条（错误、待核对）。
struct PaperclipNotice: View {
    let text: String
    var systemImage = "exclamationmark.triangle.fill"
    var tint: Color = LeoTheme.ColorToken.warning
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage).font(.subheadline).foregroundStyle(tint)
            Text(text).font(.footnote).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
            if let actionTitle, let action {
                Button(actionTitle, action: action).font(.footnote.weight(.semibold)).buttonStyle(.borderless)
            }
        }
        .padding(12)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous))
    }
}
