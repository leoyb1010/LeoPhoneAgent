import SwiftUI
import UIKit

// MARK: - 状态语义色

/// 状态与优先级的外观：色调与符号来自纯逻辑的 PaperclipStatusLook / PaperclipPriorityLook，
/// 这里只把色调映射到 LeoTheme（浅色/深色自适应）。形状与颜色同时区分，色弱也能分辨。
enum PaperclipStatusStyle {
    static func tint(_ tone: PaperclipTone) -> Color {
        switch tone {
        case .accent: return LeoTheme.ColorToken.accent
        case .review: return Color(uiColor: .systemIndigo)
        case .attention: return LeoTheme.ColorToken.warning
        case .success: return LeoTheme.ColorToken.success
        case .failure: return LeoTheme.ColorToken.destructive
        case .neutral: return LeoTheme.ColorToken.secondaryText
        case .muted: return LeoTheme.ColorToken.tertiaryText
        }
    }
    static func color(_ status: String) -> Color { tint(PaperclipStatusLook.tone(status)) }
    static func symbol(_ status: String) -> String { PaperclipStatusLook.symbol(status) }
}

/// 带语义色与形状的状态胶囊；文字就是中文状态，便于朗读与界面测试定位。
/// 状态变化时符号替换、颜色渐变（Reduce Motion 下直接切换）。
struct PaperclipStatusCapsule: View {
    let status: String
    var compact = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = PaperclipStatusStyle.color(status)
        HStack(spacing: 4) {
            Image(systemName: PaperclipStatusStyle.symbol(status))
                .font(compact ? .caption2.weight(.bold) : .caption.weight(.bold))
                .contentTransition(.symbolEffect(.replace))
                .accessibilityHidden(true)
            Text(PaperclipLabels.status(status))
                .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                .lineLimit(1)
                .contentTransition(.opacity)
        }
        .foregroundStyle(color)
        .padding(.horizontal, compact ? 7 : 9)
        .padding(.vertical, compact ? 3 : 5)
        .background(color.opacity(0.13), in: Capsule())
        .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: LeoMotion.panel), value: status)
    }
}

/// 列表行首的状态符号：形状区分状态；有运行中的 run 时外圈一圈平静的呼吸光晕（不是转圈）。
struct PaperclipStatusGlyph: View {
    let status: String
    var running = false
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 18
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let tint = running ? LeoTheme.ColorToken.accent : PaperclipStatusStyle.color(status)
        Image(systemName: PaperclipStatusStyle.symbol(status))
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(tint)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: size + 6, height: size + 6)
            .background { PaperclipLivePulse(active: running, tint: tint, diameter: size + 6, showsDot: false) }
            .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: LeoMotion.panel), value: status)
            .animation(LeoMotion.smooth(reduceMotion: reduceMotion, duration: LeoMotion.panel), value: running)
            .accessibilityHidden(true)
    }
}

/// 优先级符号：紧急、高着色，中、低用三级灰；未知不显示。
struct PaperclipPriorityGlyph: View {
    let priority: String
    var body: some View {
        if let symbol = PaperclipPriorityLook.symbol(priority) {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .foregroundStyle(PaperclipStatusStyle.tint(PaperclipPriorityLook.tone(priority)))
                .accessibilityLabel(Text("优先级\(PaperclipLabels.priority(priority))"))
        }
    }
}

/// 运行中的平静呼吸：一圈光晕缓慢向外扩散并淡出（1.8 秒一次），不是转圈。
/// Reduce Motion 或不活跃时完全静止（只留实心点，或什么都不画）。
struct PaperclipLivePulse: View {
    let active: Bool
    var tint: Color = LeoTheme.ColorToken.accent
    var diameter: CGFloat = 8
    var showsDot = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        ZStack {
            if active && !reduceMotion {
                Circle()
                    .stroke(tint.opacity(0.55), lineWidth: max(1, diameter / 8))
                    .scaleEffect(expanded ? 1.9 : 1)
                    .opacity(expanded ? 0 : 0.9)
            }
            if showsDot {
                Circle().fill(active ? tint : LeoTheme.ColorToken.tertiaryText)
            }
        }
        .frame(width: diameter, height: diameter)
        .onAppear { start() }
        .onChange(of: active) { _, _ in start() }
        .onChange(of: reduceMotion) { _, _ in start() }
        .accessibilityHidden(true)
    }

    private func start() {
        guard active, !reduceMotion else { expanded = false; return }
        expanded = false
        withAnimation(.easeOut(duration: 1.8).repeatForever(autoreverses: false)) { expanded = true }
    }
}

// MARK: - 布局

/// 属性胶囊的自动换行：一行放不下就折到下一行，大字号下不截断。
struct PaperclipFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                                      proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            let itemWidth = min(size.width, width)
            let next = current.indices.isEmpty ? itemWidth : current.width + spacing + itemWidth
            if !current.indices.isEmpty && next > width {
                rows.append(current)
                current = ([index], itemWidth, size.height)
            } else {
                current = (current.indices + [index], next, max(current.height, size.height))
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

/// 分组列表里一行的位置：决定圆角（首行上圆角、末行下圆角）与分隔线。
enum PaperclipRowPosition: Equatable {
    case single, first, middle, last
    init(index: Int, count: Int) {
        switch (index, count) {
        case (_, 1): self = .single
        case (0, _): self = .first
        case (count - 1, _): self = .last
        default: self = .middle
        }
    }
    var shape: UnevenRoundedRectangle {
        let r = LeoTheme.Radius.surface
        let top: CGFloat = (self == .single || self == .first) ? r : 0
        let bottom: CGFloat = (self == .single || self == .last) ? r : 0
        return UnevenRoundedRectangle(topLeadingRadius: top, bottomLeadingRadius: bottom,
                                      bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous)
    }
    var showsSeparator: Bool { self == .first || self == .middle }
}

/// 列表行的按压反馈：底色轻微加深（不缩放，分组容器里的行缩放会错位）。
struct PaperclipRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay { Color.primary.opacity(configuration.isPressed ? 0.06 : 0).allowsHitTesting(false) }
    }
}

// MARK: - 加载占位

/// 骨架占位块：与真实内容同尺寸的圆角灰块，叠一层全 App 共用的流光（Reduce Motion 下静止）。
struct PaperclipSkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat = 12
    var body: some View {
        RoundedRectangle(cornerRadius: height / 2, style: .continuous)
            .fill(Color.primary.opacity(0.08))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// 流光只落在骨架块上（遮罩为内容本身），空白处不扫过。
private struct PaperclipSkeletonSheen: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay { LeoShimmer().mask { content } }
    }
}

/// 列表加载中：四行与真实行同版式的骨架，加载完成后原位替换，不跳版。
struct PaperclipIssueListSkeleton: View {
    private let widths: [CGFloat] = [0.82, 0.64, 0.74, 0.55]
    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                ForEach(widths.indices, id: \.self) { index in
                    HStack(alignment: .top, spacing: 12) {
                        Circle().fill(Color.primary.opacity(0.08)).frame(width: 22, height: 22)
                        VStack(alignment: .leading, spacing: 8) {
                            PaperclipSkeletonBar(width: 64, height: 10)
                            PaperclipSkeletonBar(width: max(80, (geo.size.width - 80) * widths[index]), height: 14)
                            PaperclipSkeletonBar(width: 110, height: 10)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if index < widths.count - 1 { Divider().padding(.leading, 48) }
                }
            }
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .overlay(LeoShimmer())
            .clipShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        }
        .frame(height: 4 * 88)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("正在加载任务"))
    }
}

/// 详情加载中：头部与三段对话的骨架。
struct PaperclipDetailSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PaperclipSkeletonBar(width: 120, height: 22)
            PaperclipSkeletonBar(height: 22)
            PaperclipSkeletonBar(width: 200, height: 22)
            HStack(spacing: 8) {
                PaperclipSkeletonBar(width: 90, height: 28)
                PaperclipSkeletonBar(width: 70, height: 28)
            }
            .padding(.bottom, LeoTheme.Spacing.md)
            ForEach(0..<3, id: \.self) { index in
                HStack(spacing: 8) {
                    Circle().fill(Color.primary.opacity(0.08)).frame(width: 24, height: 24)
                    PaperclipSkeletonBar(width: 90, height: 12)
                }
                VStack(alignment: .leading, spacing: 8) {
                    PaperclipSkeletonBar(height: 12)
                    PaperclipSkeletonBar(height: 12)
                    PaperclipSkeletonBar(width: index == 1 ? 120 : 180, height: 12)
                }
                .padding(.leading, 32)
                .padding(.bottom, LeoTheme.Spacing.sm)
            }
        }
        .modifier(PaperclipSkeletonSheen())
        .padding(.top, LeoTheme.Spacing.sm)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("正在加载任务"))
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
            PaperclipLivePulse(active: connected, tint: LeoTheme.ColorToken.success, diameter: 6)
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("paperclip.liveBadge")
    }
}

// MARK: - 时间显示

enum PaperclipTimeText {
    /// 详情页的更新时间（今天显示时刻、昨天带时刻）。
    static func relative(_ value: String?, now: Date = Date()) -> String? {
        PaperclipDates.parse(value).map { PaperclipRelativeTime.detail($0, now: now) }
    }

    /// 列表行的紧凑时间。
    static func compact(_ value: String?, now: Date) -> String? {
        PaperclipDates.parse(value).map { PaperclipRelativeTime.compact($0, now: now) }
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
