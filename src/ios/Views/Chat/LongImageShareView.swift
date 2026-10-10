import SwiftUI
import UIKit

// [F2-long-image] Chat ⋯ menu →「分享为长图」: the conversation (or a range of
// turns) rendered with ImageRenderer in the current light/dark appearance, cut
// into images no taller than LongImageTranscript.maxPageHeight. Content rules
// live in LongImageTranscript (text only, internal tags stripped).

extension Notification.Name {
    /// Posted by the chat menu; the listener on that chat's AIChatView presents the sheet.
    static let chatLongImageShareRequested = Notification.Name("chatLongImageShareRequested")
}

extension LongImageTranscript {
    /// The chat's messages reduced to what may appear in the image.
    @MainActor
    static func sources(from messages: [ChatMessage]) -> [Source] {
        messages.compactMap { message in
            guard !message.isCompactedHistory else { return nil }
            switch message.role {
            case .user:
                return Source(role: .user, text: message.content, attachmentCount: message.attachments.count)
            case .assistant:
                let text = message.blocks.filter { $0.kind == .text }.map(\.content).joined(separator: "\n\n")
                return Source(role: .assistant, text: text, error: message.error)
            case .compactDivider, .systemInfo:
                return nil
            }
        }
    }
}

struct LongImageShareListener: ViewModifier {
    let vm: AIChatViewModel
    @State private var request: LongImageRequest?

    struct LongImageRequest: Identifiable {
        let id = UUID()
        let items: [LongImageTranscript.Item]
    }

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .chatLongImageShareRequested)) { note in
                if let target = note.userInfo?["sessionId"] as? String, target != vm.sessionId { return }
                // A Face ID-locked chat hands out nothing until unlocked.
                if let sid = vm.sessionId, SessionLockStore.shared.isVisuallyLocked(sid) {
                    LeoHaptics.notification(.error)
                    return
                }
                let items = LongImageTranscript.items(from: LongImageTranscript.sources(from: vm.messages))
                guard !items.isEmpty else { return }
                request = LongImageRequest(items: items)
            }
            .sheet(item: $request) { request in
                LongImageShareView(items: request.items)
            }
    }
}

struct LongImageShareView: View {
    let items: [LongImageTranscript.Item]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var fromTurn = 0
    @State private var toTurn = 0
    @State private var isRendering = false
    @State private var output: [URL] = []
    @State private var previews: [UIImage] = []
    @State private var notice: String?

    private var turnStarts: [Int] { LongImageTranscript.turnStarts(items) }

    private func turnLabel(_ turn: Int) -> String {
        let starts = turnStarts
        guard turn < starts.count else { return "" }
        let text = items[starts[turn]].text
            .split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let short = text.isEmpty ? String(localized: "(附件)") : String(text.prefix(18))
        return String(localized: "第 \(turn + 1) 轮 · \(short)")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(String(localized: "从"), selection: $fromTurn) {
                        ForEach(turnStarts.indices, id: \.self) { Text(turnLabel($0)).tag($0) }
                    }
                    Picker(String(localized: "到"), selection: $toTurn) {
                        ForEach(turnStarts.indices, id: \.self) { Text(turnLabel($0)).tag($0) }
                    }
                } header: {
                    Text(String(localized: "范围"))
                } footer: {
                    Text(String(localized: "只包含对话文字:不含思考过程、工具调用、文件路径和附件内容。跟随当前的浅色/深色外观,太长时自动分成多张。"))
                }

                Section {
                    Button {
                        Task { await render() }
                    } label: {
                        if isRendering {
                            HStack { ProgressView(); Text(String(localized: "正在生成…")) }
                        } else {
                            Label(String(localized: "生成长图"), systemImage: "photo.on.rectangle")
                        }
                    }
                    .disabled(isRendering)
                    if let notice {
                        Text(notice).font(.footnote).foregroundStyle(.secondary)
                    }
                    if !output.isEmpty {
                        ShareLink(items: output) {
                            Label(String(localized: "分享 \(output.count) 张图片"), systemImage: "square.and.arrow.up")
                        }
                    }
                }

                if !previews.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(previews.indices, id: \.self) { index in
                                    Image(uiImage: previews[index])
                                        .resizable()
                                        .scaledToFit()
                                        .frame(height: 220)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 0.5))
                                        .accessibilityLabel(Text(String(localized: "第 \(index + 1) 张")))
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(String(localized: "分享为长图"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
            }
            .onAppear {
                let last = max(0, turnStarts.count - 1)
                toTurn = last
                // Very long chats start at the last 10 turns; the pickers widen it.
                fromTurn = max(0, last - 9)
            }
        }
    }

    // MARK: Rendering

    @MainActor
    private func render() async {
        isRendering = true
        notice = nil
        output = []
        previews = []
        defer { isRendering = false }
        await Task.yield()

        let selected = LongImageTranscript.items(items, turns: fromTurn, through: toTurn)
        let scheme = colorScheme
        let width = LongImageTranscript.pageWidth
        let footerHeight: CGFloat = 36
        // Header first, then the bubbles.
        let rows: [AnyView] = [AnyView(LongImageHeader())] + selected.map { AnyView(LongImageBubble(item: $0)) }
        let heights = rows.map { measure($0, width: width, scheme: scheme) }
        var pages = LongImageTranscript.paginate(heights: heights,
                                                 maxHeight: LongImageTranscript.maxPageHeight - footerHeight)
        if pages.count > LongImageTranscript.maxPages {
            pages = Array(pages.prefix(LongImageTranscript.maxPages))
            notice = String(localized: "内容太长,只生成了前 \(LongImageTranscript.maxPages) 张。可以缩小范围再试。")
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("long-image-\(AIChatViewModel.exportStamp.string(from: Date()))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var urls: [URL] = []
        var thumbs: [UIImage] = []
        for (number, slices) in pages.enumerated() {
            let page = VStack(spacing: 0) {
                ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                    rows[slice.index]
                        .frame(width: width)
                        .fixedSize(horizontal: false, vertical: true)
                        .offset(y: -slice.y)
                        .frame(width: width, height: slice.height, alignment: .top)
                        .clipped()
                }
                LongImageFooter(page: number + 1, total: pages.count)
                    .frame(width: width, height: footerHeight)
            }
            .frame(width: width)
            .background(Color(uiColor: .systemBackground))
            .environment(\.colorScheme, scheme)

            let renderer = ImageRenderer(content: page)
            renderer.scale = 2
            guard let image = renderer.uiImage, let data = image.pngData() else { continue }
            let url = dir.appendingPathComponent("leobot-chat-\(number + 1).png")
            do {
                try data.write(to: url, options: .atomic)
                urls.append(url)
                if thumbs.count < 6 { thumbs.append(image.preparingThumbnail(of: CGSize(width: 180, height: 600)) ?? image) }
            } catch {
                notice = String(localized: "保存图片失败:\(error.localizedDescription)")
            }
            await Task.yield()
        }
        output = urls
        previews = thumbs
        if urls.isEmpty, notice == nil { notice = String(localized: "没有可以生成的内容。") }
        LeoHaptics.notification(urls.isEmpty ? .error : .success)
    }

    @MainActor
    private func measure(_ view: AnyView, width: CGFloat, scheme: ColorScheme) -> CGFloat {
        let host = UIHostingController(rootView: AnyView(
            view.frame(width: width).fixedSize(horizontal: false, vertical: true)
                .environment(\.colorScheme, scheme)))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }
}

// MARK: - Image content

private struct LongImageHeader: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "LeoBot").font(.headline)
            Text(Date.now.formatted(date: .abbreviated, time: .shortened))
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.top, 20)
        .padding(.bottom, 8)
    }
}

private struct LongImageFooter: View {
    let page: Int
    let total: Int
    var body: some View {
        Text(total > 1 ? String(localized: "由 LeoBot 生成 · \(page)/\(total)") : String(localized: "由 LeoBot 生成"))
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity)
    }
}

private struct LongImageBubble: View {
    let item: LongImageTranscript.Item

    private var attributed: AttributedString {
        (try? AttributedString(markdown: item.text,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(item.text)
    }

    var body: some View {
        HStack {
            if item.role == .user { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 4) {
                if item.attachmentCount > 0 {
                    Label(String(localized: "附件 ×\(item.attachmentCount)"), systemImage: "paperclip")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !item.text.isEmpty {
                    Text(attributed)
                        .font(.system(size: 15))
                        .foregroundStyle(item.isError ? Color.red : Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, item.role == .user ? 12 : 0)
            .padding(.vertical, item.role == .user ? 9 : 2)
            .background {
                if item.role == .user {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground))
                }
            }
            if item.role == .assistant { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 7)
    }
}
