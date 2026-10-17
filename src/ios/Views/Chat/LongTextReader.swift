import SwiftUI
import UIKit

// [T-long-reply-collapse] 超长回复的视图部分:折叠块的缓存、「展开全文」一行、全文阅读器。
// 切分规则全在 LongTextCollapse(纯逻辑,有单测);这里只负责把它接到界面上。

// MARK: - Collapse cache

/// 折叠块在屏幕上用到的东西,按 block.id 记忆。
///
/// - 每次 body 求值都要问「这个块折不折」:没超阈值的块在 O(1) 的 UTF-8 长度检查处就返回;
///   超过的块只在内容变化时重新切分(key = block.id + UTF-8 长度 + contentHash)。
/// - 折叠块不能用 `block.cachedMarkdown / cachedAttributedString`:它们是「全文」的解析与渲染,
///   传给 SelectableMarkdownView 就等于把全文又画了一遍。这里给 head 自己建一份,
///   否则视图每次出现(cell 复用)都要把 head 解析 + 渲染两遍(sizeThatFits 一次、updateUIView 一次)。
@MainActor
final class LongTextCollapseCache {
    static let shared = LongTextCollapseCache()

    @MainActor
    final class Collapse {
        /// 行内显示的开头。
        let head: String
        /// 全文字数(Character),「展开全文(共 N 字)」用。
        let totalCount: Int
        fileprivate let utf8Count: Int
        fileprivate let contentHash: Int
        private var parsed: MarkdownContent?
        private var rendered: NSAttributedString?
        private var renderedFontSize: CGFloat = 0

        fileprivate init(head: String, totalCount: Int, utf8Count: Int, contentHash: Int) {
            self.head = head
            self.totalCount = totalCount
            self.utf8Count = utf8Count
            self.contentHash = contentHash
        }

        func markdownContent() -> MarkdownContent {
            if let parsed { return parsed }
            let content = MarkdownContent(prepareMarkdownForRender(head))
            parsed = content
            return content
        }

        /// 字号变了(动态字体 / 设置)就重画;文本视图自己也会在字号变化时丢掉预渲染结果。
        func attributedString(fontSize: CGFloat) -> NSAttributedString {
            if let rendered, renderedFontSize == fontSize { return rendered }
            let string = renderMarkdownBlocksForDisplay(markdownContent().blocks, source: head)
            rendered = string
            renderedFontSize = fontSize
            return string
        }
    }

    private struct Slot {
        let utf8Count: Int
        let contentHash: Int
        /// nil = 这个内容不需要折叠(也记下来,免得每次 body 都重新数 Character)。
        let collapse: Collapse?
    }

    private var slots: [UUID: Slot] = [:]
    /// LRU,最旧的在前。同屏的折叠块至多两三个;每项带着 head 的渲染结果(~MB 级),所以只留 8 个,
    /// 滚回被挤掉的块最多重新解析一次。
    private var order: [UUID] = []
    private let capacity = 8

    private init() {
        // 内存告警:同 ThumbnailCache / ViewModelCache,先把可重建的缓存还回去。
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.slots.removeAll()
                self?.order.removeAll()
            }
        }
    }

    /// 「这个块折不折」的唯一判据:行内视图(AssistantBlockView)和列表的高度种子必须共用它,
    /// 否则种子按全文量、视图按 head 画,折叠块下面会留一大块空白。
    /// - 流式中的块不折叠(避免闪烁与跳动);
    /// - `isLiveTail` = 「本轮还在进行时的最后一个块」:续写 / 重试会让它在折叠与展开之间闪,
    ///   也等这一轮结束再折。
    func collapse(for block: AssistantBlock, isLiveTail: Bool) -> Collapse? {
        guard !block.isStreamingText, !isLiveTail else { return nil }
        // Character 数 ≤ UTF-8 字节数:没超阈值的块(绝大多数)在这里 O(1) 返回。
        let utf8Count = block.content.utf8.count
        guard utf8Count > LongTextCollapse.collapseThreshold else { return nil }
        let hash = block.contentHash
        if let slot = slots[block.id], slot.utf8Count == utf8Count, slot.contentHash == hash {
            touch(block.id)
            return slot.collapse
        }
        let content = block.content
        let collapse = LongTextCollapse.split(markdown: content).map {
            Collapse(head: $0.head, totalCount: content.count, utf8Count: utf8Count, contentHash: hash)
        }
        slots[block.id] = Slot(utf8Count: utf8Count, contentHash: hash, collapse: collapse)
        touch(block.id)
        return collapse
    }

    private func touch(_ id: UUID) {
        if let index = order.firstIndex(of: id) { order.remove(at: index) }
        order.append(id)
        while order.count > capacity, let oldest = order.first {
            order.removeFirst()
            slots.removeValue(forKey: oldest)
        }
    }
}

// MARK: - 「展开全文」一行

/// 折叠块下面的一行:和聊天里别的小胶囊行(已工作 N 步 / 已运行 N 个工具)同一套样式,
/// 点按区域 44 pt(胶囊本身 30 pt,上下的余量也算点按区)。
struct LongTextExpandRow: View {
    /// 这一行占的高度(= 最小点按区域),列表算折叠块高度种子时加上它。
    static let height = LeoTheme.TouchTarget.minimum

    let characterCount: Int
    let onExpand: () -> Void

    var body: some View {
        let title = AppLocalized("展开全文（共 \(characterCount.formatted()) 字）")
        Button {
            LeoHaptics.selection()
            onExpand()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 12, weight: .semibold))
                Text(verbatim: title)
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(LeoTheme.ColorToken.accent)
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(Color.primary.opacity(0.045), in: Capsule())
            .frame(height: Self.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: title))
        .accessibilityHint(Text("在阅读页中查看完整内容"))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("assistantTextExpandRow")
    }
}

// MARK: - 全文阅读器

/// 全文阅读器:把全文分成每页 ~8K 字的小段,每段一个 SelectableMarkdownView,放进 LazyVStack ——
/// 滚到哪页才建哪页,任何时候都不会再出现「一个 7 万点高的 UITextView」。
/// 没有直接用 PaginatedMarkdownView:它 5 万字以内走单个视图(20–50K 字的回复会原样复现卡顿),
/// 切分又只认空行(一整段长文 / 一个超长代码块切不开)。分页规则在 LongTextCollapse.pages 里,有单测。
///
/// 每页是独立的文本视图,选择只能在一页内进行;整条复制走右上角「复制全文」。
struct LongTextReaderView: View {
    let markdown: String
    var characterCount: Int?
    let onClose: () -> Void

    private struct Page: Identifiable {
        let id: Int
        let text: String
    }

    @State private var pages: [Page]?

    var body: some View {
        NavigationStack {
            Group {
                if let pages {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(pages) { page in
                                SelectableMarkdownView(markdown: page.text)
                                    .padding(.horizontal)
                                    .padding(.vertical, 4)
                            }
                        }
                        .frame(maxWidth: LeoTheme.Reading.maxWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, LeoTheme.Spacing.lg)
                    }
                } else {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Preparing large document…")
                            .font(.footnote)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(ChatColors.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(Text("关闭"))
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("全文").font(.headline)
                        if let characterCount {
                            Text(verbatim: AppLocalized("\(characterCount.formatted()) 字"))
                                .font(.caption2)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                        }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: copyAll) {
                        Image(systemName: "doc.on.doc")
                    }
                    .accessibilityLabel(Text("复制全文"))
                }
            }
        }
        .task { await loadPages() }
    }

    /// 分页在后台线程做:20 万字也只是毫秒级,但不该占主线程。
    private func loadPages() async {
        let text = markdown
        let size = LongTextCollapse.readerPageSize
        pages = await Task.detached(priority: .userInitiated) {
            LongTextCollapse.pages(markdown: text, pageSize: size)
                .enumerated()
                .map { Page(id: $0.offset, text: $0.element) }
        }.value
    }

    /// 与回复操作栏的默认复制同一个格式开关(leo.copyFormat);拿的是全文,不是某一页。
    private func copyAll() {
        let wantsMarkdown = UserDefaults.standard.string(forKey: "leo.copyFormat") == "markdown"
        UIPasteboard.general.string = wantsMarkdown ? markdown : WatchTextSanitizer.plain(markdown)
        LeoHaptics.content(.copied)
        MinisToast.show(AppLocalized("Copied"))
    }
}

// MARK: - 从 UIKit 弹出

/// 从最上层的 UIKit 控制器弹出阅读器,不从 cell 里弹:聊天列表的 cell 跑在
/// `.transaction { disablesAnimations = true }` 里,cell 内的 `.sheet` 会丢掉滑入动画、
/// 多个 cell 绑定同时求值还出过重复弹出的崩溃,所以列表自己把工具详情等 sheet 也放在 cell 树之外。
/// 做法同 OffloadPermissionDialog。
@MainActor
enum LongTextReaderPresenter {
    private static weak var shown: UIViewController?

    static func present(markdown: String, characterCount: Int? = nil) {
        // 连点两下:上一个还在屏幕上(或正在出现)就不再叠一个。
        if let shown, shown.presentingViewController != nil || shown.isBeingPresented { return }
        guard let top = topController() else { return }
        let host = UIHostingController(
            rootView: LongTextReaderView(markdown: markdown, characterCount: characterCount, onClose: {}))
        host.rootView = LongTextReaderView(markdown: markdown, characterCount: characterCount) { [weak host] in
            host?.dismiss(animated: true)
        }
        host.sheetPresentationController?.detents = [.large()]
        host.sheetPresentationController?.prefersGrabberVisible = true
        shown = host
        top.present(host, animated: true)
    }

    /// 当前用户正在用的窗口(iPad 多窗口取前台那个,不取 App 锁的窗口)里最上面的控制器。
    /// 正在出现 / 消失的控制器上 present 会被 UIKit 拒绝:此时放弃,用户再点一次即可。
    private static func topController() -> UIViewController? {
        var top = UIApplication.shared.leoActiveKeyWindow?.rootViewController
        while let next = top?.presentedViewController {
            if next.isBeingDismissed || next.isBeingPresented { return nil }
            top = next
        }
        return top
    }
}
