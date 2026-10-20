//
//  SSHTerminalView.swift
//  MinisApp
//
//  交互 SSH 终端的界面：SwiftTerm 渲染（ANSI 颜色、鼠标、选择复制、粘贴都交给它），
//  键盘附件栏（Esc / Tab / 粘滞 Ctrl / 方向键可长按连发 / 常用符号 / ^C / 粘贴 / 全屏输入），
//  顶部细状态条，双指捏合调字号，深浅色跟随系统。
//

import SwiftTerm
import SwiftUI
import UIKit

/// SwiftTerm 也有 Color；本文件里的 Color 指 SwiftUI 的。
private typealias Color = SwiftUI.Color

// MARK: - 打开方式

/// 全屏 present。关闭时断开连接（有 tmux 的话远端会话还在，下次打开接着用）。
final class SSHTerminalHostingController: UIHostingController<SSHTerminalScreen> {
    private let session: SSHTerminalSession

    init(host: RemoteHost) {
        let session = SSHTerminalSession(host: host)
        self.session = session
        super.init(rootView: SSHTerminalScreen(session: session, onClose: {}))
        rootView = SSHTerminalScreen(session: session, onClose: { [weak self] in
            self?.session.close()
            self?.dismiss(animated: true)
        })
        modalPresentationStyle = .fullScreen
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) { nil }
}

// MARK: - 屏幕

struct SSHTerminalScreen: View {
    @ObservedObject var session: SSHTerminalSession
    let onClose: () -> Void
    @State private var composing = false
    @State private var draft = ""
    @State private var returnAfterSend = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            header
            SSHStatusLine(mode: lineMode)
            if session.showTmuxHint { tmuxHint }
            SSHTerminalRepresentable(session: session, onCompose: { composing = true })
                .overlay(alignment: .bottom) { disconnectedCard }
        }
        .background(Color(uiColor: SSHTerminalTheme.background).ignoresSafeArea())
        .sheet(isPresented: $composing, onDismiss: { session.sink?.focus() }) { composeSheet }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Color.primary.opacity(0.08)))
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel(Text("关闭终端"))

            VStack(alignment: .leading, spacing: 1) {
                Text(session.host.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(statusColor).frame(width: 6, height: 6)
                    Text(statusText).lineLimit(1)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: statusText)
            }
            .contentShape(Rectangle())
            .onTapGesture { if case .disconnected = session.status { session.reconnectNow() } }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var statusText: String {
        switch session.status {
        case .connecting: return AppLocalized("连接中…")
        case .connected:
            return session.title.isEmpty ? AppLocalized("已连接") : AppLocalized("已连接 · \(session.title)")
        case .reconnecting(let attempt):
            return attempt > 1 ? AppLocalized("重连中…（第 \(attempt) 次）") : AppLocalized("重连中…")
        case .disconnected(let message):
            return message == nil ? AppLocalized("会话已结束 · 点按重连") : AppLocalized("已断开 · 点按重连")
        }
    }

    private var statusColor: Color {
        switch session.status {
        case .connected: return .green
        case .connecting, .reconnecting: return .orange
        case .disconnected: return .red
        }
    }

    private var lineMode: SSHStatusLine.Mode {
        switch session.status {
        case .connected: return .hidden
        case .connecting, .reconnecting: return .busy
        case .disconnected: return .error
        }
    }

    private var tmuxHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "lightbulb")
            Text("装 tmux 可断线续接（Mac：brew install tmux）")
                .lineLimit(2)
            Spacer(minLength: 0)
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { session.showTmuxHint = false }
            } label: {
                Image(systemName: "xmark").font(.caption.weight(.semibold))
            }
            .accessibilityLabel(Text("关闭提示"))
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.thinMaterial)
        .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        .task {
            try? await Task.sleep(for: .seconds(8))
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { session.showTmuxHint = false }
        }
    }

    @ViewBuilder
    private var disconnectedCard: some View {
        if case .disconnected(let message) = session.status {
            VStack(alignment: .leading, spacing: 10) {
                Text(message ?? AppLocalized("远端 shell 已退出。"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    session.reconnectNow()
                } label: {
                    Label("重新连接", systemImage: "arrow.clockwise")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.regularMaterial))
            .padding(16)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var composeSheet: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextEditor(text: $draft)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                Toggle("发送后回车", isOn: $returnAfterSend)
                    .font(.subheadline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .navigationTitle(Text("全屏输入"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AppLocalized("取消")) { composing = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(AppLocalized("发送")) {
                        session.sink?.paste(text: draft)
                        if returnAfterSend { session.send([13]) }
                        draft = ""
                        composing = false
                    }
                    .disabled(draft.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// 头部下方 2pt 的细线：连接中一道光从左扫到右（Reduce Motion 时静止），断开时红色，已连接时隐藏。
struct SSHStatusLine: View {
    enum Mode { case hidden, busy, error }
    let mode: Mode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -0.4

    var body: some View {
        GeometryReader { geo in
            switch mode {
            case .hidden:
                Color.clear
            case .error:
                Rectangle().fill(Color.red.opacity(0.55))
            case .busy:
                if reduceMotion {
                    Rectangle().fill(Color.accentColor.opacity(0.35))
                } else {
                    LinearGradient(colors: [.clear, .accentColor.opacity(0.85), .clear],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.4)
                        .offset(x: phase * geo.size.width)
                        .onAppear {
                            phase = -0.4
                            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { phase = 1 }
                        }
                }
            }
        }
        .frame(height: 2)
        .clipped()
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: mode)
        .accessibilityHidden(true)
    }
}

// MARK: - SwiftTerm 视图

private struct SSHTerminalRepresentable: UIViewRepresentable {
    let session: SSHTerminalSession
    let onCompose: () -> Void

    func makeUIView(context: Context) -> LeoSSHTerminalView {
        let view = LeoSSHTerminalView(session: session, onCompose: onCompose)
        session.sink = view
        return view
    }

    func updateUIView(_ uiView: LeoSSHTerminalView, context: Context) {}
}

enum SSHTerminalTheme {
    static let background = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.067, green: 0.071, blue: 0.082, alpha: 1)
        : UIColor(red: 0.984, green: 0.984, blue: 0.980, alpha: 1) }
    static let foreground = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.871, green: 0.878, blue: 0.894, alpha: 1)
        : UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1) }

    /// 16 色 ANSI：深色沿用柔和的 One Dark 系，浅色换成在白底上读得清的深一档。
    static func palette(dark: Bool) -> [SwiftTerm.Color] {
        let hex: [UInt32] = dark
            ? [0x2E3036, 0xE06C75, 0x98C379, 0xE5C07B, 0x61AFEF, 0xC678DD, 0x56B6C2, 0xDCDFE4,
               0x5C6370, 0xEF8891, 0xB5D99C, 0xF0D197, 0x8CC8F7, 0xD7A1E7, 0x7FCAD4, 0xFFFFFF]
            : [0x1F2328, 0xC4314B, 0x287D3C, 0x9A6700, 0x0969DA, 0x8250DF, 0x1B7C83, 0x6E7781,
               0x57606A, 0xD1453B, 0x3A9E5C, 0xB58407, 0x218BFF, 0xA475F9, 0x3192AA, 0x8C959F]
        return hex.map { value in
            let r = UInt16((value >> 16) & 0xFF), g = UInt16((value >> 8) & 0xFF), b = UInt16(value & 0xFF)
            return SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
        }
    }
}

final class LeoSSHTerminalView: TerminalView, TerminalViewDelegate, SSHTerminalSink {
    private let session: SSHTerminalSession
    private var started = false
    private var pinchStartSize: CGFloat = 13
    static let fontSizes: ClosedRange<CGFloat> = 9...24

    init(session: SSHTerminalSession, onCompose: @escaping () -> Void) {
        self.session = session
        let saved = UserDefaults.standard.double(forKey: RemoteHostStore.terminalFontSizeKey)
        let size = saved > 0 ? CGFloat(saved) : 13
        super.init(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular))
        terminalDelegate = self
        optionAsMetaKey = true
        applyTheme()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LeoSSHTerminalView, _: UITraitCollection) in
            view.applyTheme()
        }
        inputAccessoryView = SSHTerminalAccessoryBar(terminal: self, onCompose: onCompose)
        addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
    }

    required init?(coder: NSCoder) { nil }

    private func applyTheme() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let bg = SSHTerminalTheme.background.resolvedColor(with: traitCollection)
        installColors(SSHTerminalTheme.palette(dark: dark))
        nativeForegroundColor = SSHTerminalTheme.foreground.resolvedColor(with: traitCollection)
        nativeBackgroundColor = bg
        backgroundColor = bg
        caretColor = .systemBlue
        indicatorStyle = dark ? .white : .black
        keyboardAppearance = dark ? .dark : .light
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // 第一次拿到真实尺寸才连：PTY 一开始就是对的行列数，不会先 80x24 再跳。
        guard !started, bounds.width > 40, bounds.height > 40 else { return }
        started = true
        let terminal = getTerminal()
        session.start(cols: terminal.cols, rows: terminal.rows)
        DispatchQueue.main.async { _ = self.becomeFirstResponder() }
    }

    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        switch gesture.state {
        case .began:
            pinchStartSize = font.pointSize
        case .changed:
            // 半磅一档，避免每帧都重排、连发 window-change。
            let target = (pinchStartSize * gesture.scale * 2).rounded() / 2
            let clamped = min(max(target, Self.fontSizes.lowerBound), Self.fontSizes.upperBound)
            guard clamped != font.pointSize else { return }
            font = UIFont.monospacedSystemFont(ofSize: clamped, weight: .regular)
        case .ended:
            UserDefaults.standard.set(Double(font.pointSize), forKey: RemoteHostStore.terminalFontSizeKey)
        default:
            break
        }
    }

    // MARK: SSHTerminalSink

    func feed(_ bytes: [UInt8]) {
        feed(byteArray: bytes[...])
    }

    func paste(text: String) {
        guard !text.isEmpty else { return }
        let bracketed = getTerminal().bracketedPasteMode
        if bracketed { send(data: EscapeSequences.bracketedPasteStart[0...]) }
        send(txt: text)
        if bracketed { send(data: EscapeSequences.bracketedPasteEnd[0...]) }
    }

    func focus() {
        _ = becomeFirstResponder()
    }

    func sendArrow(_ key: SSHTerminalAccessoryBar.Arrow) {
        let app = getTerminal().applicationCursor
        switch key {
        case .up: send(app ? EscapeSequences.moveUpApp : EscapeSequences.moveUpNormal)
        case .down: send(app ? EscapeSequences.moveDownApp : EscapeSequences.moveDownNormal)
        case .left: send(app ? EscapeSequences.moveLeftApp : EscapeSequences.moveLeftNormal)
        case .right: send(app ? EscapeSequences.moveRightApp : EscapeSequences.moveRightNormal)
        }
    }

    // MARK: TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        session.send(Array(data))
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        session.resize(cols: newCols, rows: newRows)
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        session.titleChanged(title)
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        // OSC 52（tmux / vim 复制到系统剪贴板）
        if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
    }

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        UIApplication.shared.open(url)
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

// MARK: - 键盘附件栏

/// 系统键盘同款底色的一排键。样式参照 iSH 终端的 TerminalKeyboardAccessory（同样的键位顺序与粘滞 Ctrl），
/// 改用系统按钮外观，深浅色自动跟随。
final class SSHTerminalAccessoryBar: UIInputView {
    enum Arrow { case up, down, left, right }

    private weak var terminal: LeoSSHTerminalView?
    private let onCompose: () -> Void
    private let haptic = UIImpactFeedbackGenerator(style: .soft)
    private var ctrlButton: UIButton?
    private var repeatTimer: Timer?
    private var ctrlObserver: NSObjectProtocol?

    init(terminal: LeoSSHTerminalView, onCompose: @escaping () -> Void) {
        self.terminal = terminal
        self.onCompose = onCompose
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 46), inputViewStyle: .keyboard)
        autoresizingMask = .flexibleWidth
        allowsSelfSizing = true
        build()
        ctrlObserver = NotificationCenter.default.addObserver(
            forName: .terminalViewControlModifierReset, object: terminal, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshCtrl() }
        }
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        if let ctrlObserver { NotificationCenter.default.removeObserver(ctrlObserver) }
    }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: 46) }

    private func build() {
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)

        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -8),
            stack.centerYAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerYAnchor),
            stack.heightAnchor.constraint(equalToConstant: 34),
        ])

        stack.addArrangedSubview(key(title: "esc") { [weak self] in self?.terminal?.send([0x1B]) })
        stack.addArrangedSubview(key(title: "tab") { [weak self] in self?.terminal?.send([0x09]) })
        let ctrl = key(title: "ctrl") { [weak self] in
            guard let terminal = self?.terminal else { return }
            terminal.controlModifier.toggle()
            self?.refreshCtrl()
        }
        ctrlButton = ctrl
        stack.addArrangedSubview(ctrl)
        for (arrow, symbol, label) in [(Arrow.up, "arrow.up", AppLocalized("上")), (.down, "arrow.down", AppLocalized("下")),
                                       (.left, "arrow.left", AppLocalized("左")), (.right, "arrow.right", AppLocalized("右"))] {
            stack.addArrangedSubview(repeatingKey(symbol: symbol, label: label) { [weak self] in
                self?.terminal?.sendArrow(arrow)
            })
        }
        for text in ["|", "~", "/", "-"] {
            stack.addArrangedSubview(key(title: text) { [weak self] in self?.terminal?.send(txt: text) })
        }
        stack.addArrangedSubview(key(title: "^C") { [weak self] in self?.terminal?.send([0x03]) })
        stack.addArrangedSubview(key(symbol: "doc.on.clipboard", label: AppLocalized("粘贴")) { [weak self] in
            self?.terminal?.paste(nil)
        })
        stack.addArrangedSubview(key(symbol: "keyboard.badge.ellipsis", label: AppLocalized("全屏输入")) { [weak self] in
            self?.onCompose()
        })
        stack.addArrangedSubview(key(symbol: "keyboard.chevron.compact.down", label: AppLocalized("收起键盘")) { [weak self] in
            _ = self?.terminal?.resignFirstResponder()
        })
    }

    private func baseConfiguration() -> UIButton.Configuration {
        var config = UIButton.Configuration.gray()
        config.cornerStyle = .medium
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 11, bottom: 4, trailing: 11)
        config.baseForegroundColor = .label
        config.baseBackgroundColor = .secondarySystemFill
        return config
    }

    private func key(title: String, action: @escaping () -> Void) -> UIButton {
        var config = baseConfiguration()
        var attributes = AttributeContainer()
        attributes.font = UIFont.monospacedSystemFont(ofSize: 15, weight: .medium)
        config.attributedTitle = AttributedString(title, attributes: attributes)
        return makeButton(config, label: title, action: action)
    }

    private func key(symbol: String, label: String, action: @escaping () -> Void) -> UIButton {
        var config = baseConfiguration()
        config.image = UIImage(systemName: symbol,
                               withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .medium))
        return makeButton(config, label: label, action: action)
    }

    private func makeButton(_ config: UIButton.Configuration, label: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
            self?.haptic.impactOccurred(intensity: 0.5)
            action()
        })
        button.accessibilityLabel = label
        return button
    }

    /// 方向键：按下立即发一次，按住 0.35 秒后连发。
    private func repeatingKey(symbol: String, label: String, action: @escaping () -> Void) -> UIButton {
        var config = baseConfiguration()
        config.image = UIImage(systemName: symbol,
                               withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .medium))
        let button = UIButton(configuration: config)
        button.accessibilityLabel = label
        button.addAction(UIAction { [weak self] _ in
            self?.haptic.impactOccurred(intensity: 0.5)
            action()
            self?.repeatTimer?.invalidate()
            self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { _ in
                MainActor.assumeIsolated {
                    self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { _ in
                        MainActor.assumeIsolated { action() }
                    }
                }
            }
        }, for: .touchDown)
        button.addAction(UIAction { [weak self] _ in
            self?.repeatTimer?.invalidate()
            self?.repeatTimer = nil
        }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        return button
    }

    private func refreshCtrl() {
        guard let ctrlButton, var config = ctrlButton.configuration else { return }
        let on = terminal?.controlModifier == true
        config.baseBackgroundColor = on ? .tintColor : .secondarySystemFill
        config.baseForegroundColor = on ? .white : .label
        ctrlButton.configuration = config
        ctrlButton.accessibilityValue = on ? AppLocalized("已按下") : nil
    }
}
