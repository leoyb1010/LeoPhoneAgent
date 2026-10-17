//
//  MacScreenLiveViews.swift
//  MinisApp
//
//  [WP-51 R1] 「Mac 画面」的视频模式(WebRTC),失败自动回退 R0 截图;画中画。
//  [WP-52 R2] 操控:iPhone 触控板模式 + 底部工具条;iPad 指针绝对坐标 + 外接键盘原始按键 +
//  被 iPadOS 截走的组合键替代按钮。
//

import Combine
import GameController
import SwiftUI
import UIKit
import WebRTC

// MARK: - Model

/// 一处「Mac 画面」的视频 / 截图切换。
@MainActor
final class MacScreenLiveModel: ObservableObject {
    @Published private(set) var peer: ScreenPeerClient?
    @Published private(set) var lastVideoFailure: Date?
    @Published private(set) var lastVideoError: MacScreenError?
    /// 用户点了「只看截图」。
    @Published var forcedSnapshot = false
    /// 操控开着(要了 `leo-input`)。
    @Published private(set) var controlOn = false
    @Published private(set) var pipActive = false
    /// Mac 预检说不支持视频(旧版本没有 /screen/session):这一次不再试。
    @Published private(set) var videoUnsupported = false

    let pip = ScreenPiPController()
    private var stateSub: AnyCancellable?

    var client: LeoAgentClient? {
        didSet {
            guard client !== oldValue else { return }
            peer?.stop()
            peer = client.map { ScreenPeerClient(client: $0) }
            lastVideoFailure = nil
            lastVideoError = nil
            videoUnsupported = false
            observePeer()
        }
    }

    init() {
        pip.onActiveChange = { [weak self] active in
            Task { @MainActor in self?.pipActive = active }
        }
    }

    var mode: ScreenViewModePolicy.Mode {
        ScreenViewModePolicy.mode(screenSessionSupported: peer != nil && !videoUnsupported,
                                  lastVideoFailure: lastVideoFailure,
                                  userForcedSnapshot: forcedSnapshot, now: Date())
    }

    func startVideoIfNeeded() {
        guard mode == .video, let peer, !peer.isActive else { return }
        peer.start(control: controlOn)
    }

    func stopVideo() {
        guard !pipActive else { return }   // 画中画里接着看
        peer?.stop()
    }

    func retryVideo() {
        lastVideoFailure = nil
        lastVideoError = nil
        forcedSnapshot = false
        videoUnsupported = false
        peer?.stop()
        startVideoIfNeeded()
    }

    /// 开 / 关操控要重新协商(输入通道只能在 offer 之前建)。
    func setControl(_ on: Bool) {
        guard on != controlOn else { return }
        controlOn = on
        peer?.stop()
        startVideoIfNeeded()
    }

    private func observePeer() {
        stateSub = peer?.$state.sink { [weak self] state in
            guard let self, case .failed(let error) = state else { return }
            if error.code == "not_supported" { self.videoUnsupported = true }
            self.lastVideoError = error
            self.lastVideoFailure = Date()
        }
    }
}

// MARK: - Live view (video first, snapshot fallback)

struct MacScreenLiveView<Snapshot: View>: View {
    @ObservedObject var model: MacScreenLiveModel
    @ObservedObject var poller: MacScreenPoller
    /// false = 先别连(例如全屏盖在上面，由全屏那一处连)。
    var active: Bool = true
    /// R0 截图(视频不可用 / 失败 / 用户选了截图时)。
    @ViewBuilder let snapshot: () -> Snapshot
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false

    private var wantsVideo: Bool {
        visible && active && model.mode == .video && (scenePhase == .active || model.pipActive)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            if model.mode == .video, let peer = model.peer {
                MacScreenVideoPane(model: model, peer: peer, poller: poller)
            } else {
                snapshot()
                    .macScreenLive(poller, active: active)
                    .overlay(alignment: .top) {
                        if let error = model.lastVideoError, !model.forcedSnapshot {
                            Label(ScreenSessionWire.guidance(for: error), systemImage: "video.slash")
                                .font(.caption)
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .glassEffect(.regular, in: .capsule)
                                .padding(.top, 52)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        if model.peer != nil, model.mode == .snapshot {
                            Button { model.retryVideo() } label: {
                                Label("试视频", systemImage: "video").font(.caption.weight(.semibold))
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                            }
                            .buttonStyle(.plain)
                            .glassEffect(.regular.interactive(), in: .capsule)
                            .padding(.top, 52).padding(.trailing, 12)
                        }
                    }
            }
        }
        .onAppear { visible = true; sync() }
        .onDisappear { visible = false; sync() }
        .onChange(of: scenePhase) { _, _ in sync() }
        .onChange(of: model.mode) { _, _ in sync() }
        .onChange(of: active) { _, _ in sync() }
    }

    private func sync() {
        if wantsVideo { model.startVideoIfNeeded() } else { model.stopVideo() }
    }
}

/// 视频 + 操控层 + 状态行。
private struct MacScreenVideoPane: View {
    @ObservedObject var model: MacScreenLiveModel
    @ObservedObject var peer: ScreenPeerClient
    @ObservedObject var poller: MacScreenPoller
    @State private var trackpad = ScreenTrackpad()
    private let isPad = UIDevice.current.userInterfaceIdiom == .pad

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black
            ScreenVideoSurface(peer: peer, pip: model.pip,
                               inputMode: peer.controlReady ? (isPad ? .pointer : .trackpad) : .none,
                               trackpad: $trackpad)
            if peer.state != .connected {
                ProgressView("正在连接视频…").tint(.white).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            VStack(spacing: 6) {
                notices
                if peer.controlReady {
                    if isPad { MacScreenPadKeys(peer: peer) } else { MacScreenControlBar(peer: peer) }
                }
            }
            .padding(.bottom, 8)
        }
        .overlay(alignment: .topTrailing) { videoMenu.padding(.top, 52).padding(.trailing, 12) }
        .onChange(of: peer.videoSize) { _, size in
            if size.height > 0 { trackpad.screenAspect = size.width / size.height }
        }
        .onAppear { if isPad { MacScreenHardwareKeyboard.shared.attach(peer) } }
        .onDisappear { MacScreenHardwareKeyboard.shared.detach(peer) }
        .onChange(of: peer.controlReady) { _, ready in
            if ready, isPad { MacScreenHardwareKeyboard.shared.attach(peer) }
        }
    }

    @ViewBuilder private var notices: some View {
        if peer.controlRefused {
            notice(ScreenControlGuidance.notGranted, symbol: "hand.raised")
        } else if let guidance = peer.inputStatus?.guidance {
            notice(guidance, symbol: "exclamationmark.triangle")
        } else if let stats = peer.stats, !stats.summary.isEmpty {
            Text(stats.summary).font(.caption2.monospacedDigit()).foregroundStyle(.white.opacity(0.8))
        }
    }

    private func notice(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.caption)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .glassEffect(.regular, in: .rect(cornerRadius: 12))
            .padding(.horizontal, 12)
    }

    private var videoMenu: some View {
        Menu {
            Toggle(isOn: Binding(get: { model.controlOn }, set: { model.setControl($0) })) {
                Label("操控 Mac", systemImage: "cursorarrow.click.2")
            }
            if ScreenPiPController.isSupported {
                Button { model.pip.toggle() } label: { Label("画中画", systemImage: "pip.enter") }
            }
            Button { model.forcedSnapshot = true; peer.stop() } label: {
                Label("改看截图(省流量)", systemImage: "photo")
            }
        } label: {
            Image(systemName: model.controlOn ? "cursorarrow.click.2" : "ellipsis")
                .font(.body.weight(.semibold))
                .frame(width: 36, height: 36)
                .foregroundStyle(.white)
        }
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text("视频选项"))
    }
}

// MARK: - UIKit video surface + gestures

private struct ScreenVideoSurface: UIViewRepresentable {
    enum InputMode: Equatable { case none, trackpad, pointer }

    let peer: ScreenPeerClient
    let pip: ScreenPiPController
    let inputMode: InputMode
    @Binding var trackpad: ScreenTrackpad

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ScreenVideoContainer {
        let view = ScreenVideoContainer(pip: pip)
        view.videoView.delegate = context.coordinator
        context.coordinator.install(on: view)
        return view
    }

    func updateUIView(_ view: ScreenVideoContainer, context: Context) {
        context.coordinator.parent = self
        context.coordinator.attach(track: peer.videoTrack, to: view)
        context.coordinator.updateGestures(for: inputMode)
    }

    static func dismantleUIView(_ view: ScreenVideoContainer, coordinator: Coordinator) {
        coordinator.attach(track: nil, to: view)
    }

    @MainActor
    final class Coordinator: NSObject, RTCVideoViewDelegate, UIGestureRecognizerDelegate, UIPointerInteractionDelegate {
        var parent: ScreenVideoSurface
        private weak var container: ScreenVideoContainer?
        private weak var track: RTCVideoTrack?
        private var videoSize: CGSize = .zero
        private var gestures: [UIGestureRecognizer] = []
        private var pointer: UIPointerInteraction?
        private var mode: InputMode = .none
        private var lastPan: CGPoint = .zero
        private var lastScroll: CGPoint = .zero

        init(_ parent: ScreenVideoSurface) { self.parent = parent }

        func install(on view: ScreenVideoContainer) { container = view }

        func attach(track: RTCVideoTrack?, to view: ScreenVideoContainer) {
            guard track !== self.track else { return }
            self.track?.remove(view.videoView)
            self.track?.remove(parent.pip.renderer)
            self.track = track
            track?.add(view.videoView)
            track?.add(parent.pip.renderer)
            if track != nil { parent.pip.attach() }
        }

        nonisolated func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
            Task { @MainActor in
                self.videoSize = size
                self.parent.peer.frameSizeChanged(size)
            }
        }

        private var contentRect: CGRect {
            guard let container else { return .zero }
            return ScreenGeometry.contentRect(videoSize: videoSize, in: container.bounds)
        }

        private func normalized(_ location: CGPoint) -> CGPoint? {
            ScreenGeometry.normalized(location, contentRect: contentRect)
        }

        // MARK: Gestures

        func updateGestures(for newMode: InputMode) {
            guard newMode != mode, let container else { return }
            mode = newMode
            gestures.forEach(container.removeGestureRecognizer)
            gestures = []
            if let pointer { container.removeInteraction(pointer); self.pointer = nil }
            switch newMode {
            case .none:
                break
            case .trackpad:
                let move = UIPanGestureRecognizer(target: self, action: #selector(trackpadMove(_:)))
                move.maximumNumberOfTouches = 1
                let scroll = UIPanGestureRecognizer(target: self, action: #selector(trackpadScroll(_:)))
                scroll.minimumNumberOfTouches = 2
                let tap = UITapGestureRecognizer(target: self, action: #selector(trackpadTap(_:)))
                let doubleTap = UITapGestureRecognizer(target: self, action: #selector(trackpadDoubleTap(_:)))
                doubleTap.numberOfTapsRequired = 2
                tap.require(toFail: doubleTap)
                let long = UILongPressGestureRecognizer(target: self, action: #selector(trackpadLongPress(_:)))
                long.minimumPressDuration = 0.5
                gestures = [move, scroll, tap, doubleTap, long]
            case .pointer:
                // iPad: absolute coordinates. The pointer hovers (move), clicks / taps click where they land,
                // two-finger trackpad / wheel scroll pans. The system pointer hides: the Mac's cursor is in the video.
                let hover = UIHoverGestureRecognizer(target: self, action: #selector(pointerHover(_:)))
                let tap = UITapGestureRecognizer(target: self, action: #selector(pointerTap(_:)))
                let secondary = UITapGestureRecognizer(target: self, action: #selector(pointerSecondary(_:)))
                secondary.buttonMaskRequired = .secondary
                let drag = UIPanGestureRecognizer(target: self, action: #selector(pointerDrag(_:)))
                drag.maximumNumberOfTouches = 1
                let scroll = UIPanGestureRecognizer(target: self, action: #selector(pointerScroll(_:)))
                scroll.allowedScrollTypesMask = .all
                scroll.minimumNumberOfTouches = 2
                gestures = [hover, tap, secondary, drag, scroll]
                let interaction = UIPointerInteraction(delegate: self)
                container.addInteraction(interaction)
                pointer = interaction
            }
            gestures.forEach { $0.delegate = self; container.addGestureRecognizer($0) }
        }

        nonisolated func gestureRecognizer(_ g: UIGestureRecognizer,
                                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            g is UIHoverGestureRecognizer || other is UIHoverGestureRecognizer
        }

        func pointerInteraction(_ interaction: UIPointerInteraction, styleFor region: UIPointerRegion) -> UIPointerStyle? {
            .hidden()
        }

        private func send(_ event: ScreenInputEvent) { parent.peer.send(event) }

        @objc private func trackpadMove(_ g: UIPanGestureRecognizer) {
            guard let view = g.view else { return }
            let t = g.translation(in: view)
            if g.state == .began { lastPan = .zero }
            let delta = CGSize(width: t.x - lastPan.x, height: t.y - lastPan.y)
            lastPan = t
            send(parent.trackpad.move(by: delta, padSize: view.bounds.size))
        }

        @objc private func trackpadScroll(_ g: UIPanGestureRecognizer) {
            guard let view = g.view else { return }
            let t = g.translation(in: view)
            if g.state == .began { lastScroll = .zero }
            let delta = CGSize(width: t.x - lastScroll.x, height: t.y - lastScroll.y)
            lastScroll = t
            send(parent.trackpad.scroll(by: delta))
        }

        @objc private func trackpadTap(_ g: UITapGestureRecognizer) { send(parent.trackpad.tap()) }
        @objc private func trackpadDoubleTap(_ g: UITapGestureRecognizer) { send(parent.trackpad.doubleTap()) }
        @objc private func trackpadLongPress(_ g: UILongPressGestureRecognizer) {
            if g.state == .began { send(parent.trackpad.longPress()); LeoHaptics.selection() }
        }

        @objc private func pointerHover(_ g: UIHoverGestureRecognizer) {
            guard let p = normalized(g.location(in: g.view)) else { return }
            send(.move(p))
        }

        @objc private func pointerTap(_ g: UITapGestureRecognizer) {
            guard let p = normalized(g.location(in: g.view)) else { return }
            send(.click(.left, count: 1, at: p))
        }

        @objc private func pointerSecondary(_ g: UITapGestureRecognizer) {
            guard let p = normalized(g.location(in: g.view)) else { return }
            send(.click(.right, count: 1, at: p))
        }

        @objc private func pointerDrag(_ g: UIPanGestureRecognizer) {
            guard let p = normalized(g.location(in: g.view)) else { return }
            switch g.state {
            case .began: send(.down(.left, p))
            case .changed: send(.move(p))
            default: send(.up(.left, p))
            }
        }

        @objc private func pointerScroll(_ g: UIPanGestureRecognizer) {
            guard let view = g.view else { return }
            let t = g.translation(in: view)
            if g.state == .began { lastScroll = .zero }
            let p = normalized(g.location(in: view))
            send(.scroll(dx: -Double(t.x - lastScroll.x) * 2, dy: -Double(t.y - lastScroll.y) * 2, at: p))
            lastScroll = t
        }
    }
}

final class ScreenVideoContainer: UIView {
    let videoView = RTCMTLVideoView()
    private let pip: ScreenPiPController

    init(pip: ScreenPiPController) {
        self.pip = pip
        super.init(frame: .zero)
        backgroundColor = .black
        // PiP needs its display layer in the layer tree; it sits behind the Metal view.
        layer.addSublayer(pip.renderer.displayLayer)
        videoView.videoContentMode = .scaleAspectFit
        videoView.isUserInteractionEnabled = false
        addSubview(videoView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        videoView.frame = bounds
        pip.renderer.displayLayer.frame = bounds
    }
}

// MARK: - iPhone control bar (WP-52)

/// 底部工具条:Esc / Tab / ⌘ ⌃ ⌥ ⇧(粘住)/ 方向键 / 回车 / 退格 + 文字输入(整段发，不按键模拟)。
private struct MacScreenControlBar: View {
    @ObservedObject var peer: ScreenPeerClient
    @State private var sticky = ScreenStickyModifiers()
    @State private var text = ""

    var body: some View {
        VStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    key("esc", "Escape")
                    key("tab", "Tab")
                    modifier("⌘", .cmd)
                    modifier("⌃", .ctrl)
                    modifier("⌥", .alt)
                    modifier("⇧", .shift)
                    key("←", "ArrowLeft"); key("↑", "ArrowUp"); key("↓", "ArrowDown"); key("→", "ArrowRight")
                    key("⏎", "Enter")
                    key("⌫", "Backspace")
                }
                .padding(.horizontal, 12)
            }
            HStack(spacing: 8) {
                TextField("在 Mac 上输入…", text: $text)
                    .textFieldStyle(.plain)
                    .submitLabel(.send)
                    .onSubmit(sendText)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .glassEffect(.regular, in: .capsule)
                Button(action: sendText) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(text.isEmpty)
                    .accessibilityLabel(Text("发送到 Mac"))
            }
            .padding(.horizontal, 12)
        }
    }

    private func sendText() {
        guard !text.isEmpty else { return }
        peer.sendText(text)
        text = ""
    }

    private func key(_ title: String, _ code: String) -> some View {
        Button {
            peer.send(sticky.press(code))
        } label: {
            Text(title).font(.callout.monospaced().weight(.semibold)).frame(minWidth: 34, minHeight: 32)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 8))
    }

    private func modifier(_ title: String, _ m: ScreenInputEvent.Modifier) -> some View {
        Button {
            sticky.toggle(m)
        } label: {
            Text(title).font(.callout.weight(.semibold)).frame(minWidth: 34, minHeight: 32)
        }
        .buttonStyle(.plain)
        .glassEffect(sticky.isHeld(m) ? .regular.tint(.accentColor).interactive() : .regular.interactive(),
                     in: .rect(cornerRadius: 8))
        .accessibilityAddTraits(sticky.isHeld(m) ? .isSelected : [])
    }
}

// MARK: - iPad keys (WP-52)

/// iPad:外接键盘直通(MacScreenHardwareKeyboard);iPadOS 自己截走的组合键给替代按钮。
private struct MacScreenPadKeys: View {
    @ObservedObject var peer: ScreenPeerClient

    var body: some View {
        HStack(spacing: 6) {
            ForEach(ScreenHIDKeys.reserved) { combo in
                Button {
                    peer.send(.key(code: combo.code, mods: combo.mods, phase: .press))
                } label: {
                    Text(combo.title).font(.caption.monospaced().weight(.semibold)).frame(minWidth: 44, minHeight: 30)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 8))
            }
        }
        .padding(.horizontal, 12)
    }
}

/// iPad 外接键盘:GCKeyboard 的原始 HID 按键 → `key` down / up 事件(带当前按住的修饰键)。
@MainActor
final class MacScreenHardwareKeyboard {
    static let shared = MacScreenHardwareKeyboard()
    private weak var peer: ScreenPeerClient?
    private var mods: Set<ScreenInputEvent.Modifier> = []
    private var observer: NSObjectProtocol?

    func attach(_ peer: ScreenPeerClient) {
        self.peer = peer
        install(GCKeyboard.coalesced)
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) { note in
                MainActor.assumeIsolated { MacScreenHardwareKeyboard.shared.install(note.object as? GCKeyboard) }
            }
        }
    }

    func detach(_ peer: ScreenPeerClient) {
        guard self.peer === peer else { return }
        self.peer = nil
        mods = []
        GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
    }

    private func install(_ keyboard: GCKeyboard?) {
        keyboard?.keyboardInput?.keyChangedHandler = { _, _, keyCode, pressed in
            let usage = keyCode.rawValue
            Task { @MainActor in MacScreenHardwareKeyboard.shared.handle(usage: usage, pressed: pressed) }
        }
    }

    private func handle(usage: Int, pressed: Bool) {
        guard let peer, peer.controlReady, let code = ScreenHIDKeys.code(forUsage: usage) else { return }
        if let m = ScreenHIDKeys.modifier(forUsage: usage) {
            if pressed { mods.insert(m) } else { mods.remove(m) }
        }
        let held = ScreenInputEvent.Modifier.allCases.filter(mods.contains)
        peer.send(.key(code: code, mods: held, phase: pressed ? .down : .up))
    }
}
