//
//  MacScreenViews.swift
//  MinisApp
//
//  [WP-50 R0] 「Mac 画面」:任务页的卡片、全屏查看(捏合缩放、双击复位)、iPad 右栏。
//  轮询只在页面可见且 App 在前台时进行(MacScreenLiveModifier)。
//

import SwiftUI

/// 页面可见 + 前台才轮询;退到后台、离开页面就停。
private struct MacScreenLiveModifier: ViewModifier {
    @ObservedObject var poller: MacScreenPoller
    var active: Bool = true
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    /// Whether this view currently counts as a viewer (the card and its full-screen
    /// cover share one poller; whichever appears / disappears first must not stop the other).
    @State private var holding = false

    private func sync() {
        let want = visible && active && scenePhase == .active
        guard want != holding else { return }
        holding = want
        if want { poller.acquire() } else { poller.release() }
    }

    func body(content: Content) -> some View {
        content
            .onAppear { visible = true; sync() }
            .onDisappear { visible = false; sync() }
            .onChange(of: scenePhase) { _, _ in sync() }
            .onChange(of: active) { _, _ in sync() }
    }
}

extension View {
    func macScreenLive(_ poller: MacScreenPoller, active: Bool = true) -> some View {
        modifier(MacScreenLiveModifier(poller: poller, active: active))
    }
}

/// 画面本体:有图显示图,没图显示进度或原因(带「重试」)。
struct MacScreenSurface: View {
    @ObservedObject var poller: MacScreenPoller
    var contentMode: ContentMode = .fit

    var body: some View {
        ZStack {
            if let image = poller.image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .accessibilityLabel(Text("Mac 屏幕画面"))
            } else if poller.error == nil {
                ProgressView("正在取 Mac 画面…")
                    .font(.footnote)
            }
            if let error = poller.error {
                MacScreenErrorBadge(error: error, overImage: poller.image != nil) { poller.retry() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct MacScreenErrorBadge: View {
    let error: MacScreenError
    let overImage: Bool
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Label(error.guidance, systemImage: error.needsUser ? "exclamationmark.triangle" : "arrow.triangle.2.circlepath")
                .font(.footnote)
                .multilineTextAlignment(.center)
            if error.needsUser || error.code == "screen_permission" {
                Button("重试", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .frame(maxWidth: 320)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .frame(maxHeight: .infinity, alignment: overImage ? .bottom : .center)
        .padding(8)
    }
}

/// 状态行:哪台 Mac、多久前的画面。
private struct MacScreenCaption: View {
    @ObservedObject var poller: MacScreenPoller
    let hostName: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 6) {
                Circle()
                    .fill(poller.error == nil && poller.isPolling ? Color.green : Color.secondary)
                    .frame(width: 6, height: 6)
                Text(hostName ?? "Mac")
                    .font(.caption.weight(.semibold))
                if let last = poller.lastUpdate {
                    Text(MacScreenCaption.age(since: last, now: context.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let frame = poller.frame, let w = frame.width, let h = frame.height {
                    Text("\(w)×\(h)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                }
            }
        }
    }

    static func age(since date: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        return s < 3 ? "刚刚" : "\(s) 秒前"
    }
}

/// 任务页的「Mac 画面」卡片。点一下全屏。
struct MacScreenCard: View {
    @ObservedObject var poller: MacScreenPoller
    let hostName: String?
    @State private var fullscreen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MacScreenCaption(poller: poller, hostName: hostName)
            Button { fullscreen = true } label: {
                MacScreenSurface(poller: poller)
                    .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityHint(Text("全屏查看"))
        }
        .padding(10)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
        // The full-screen view runs its own (video first); the card waits underneath.
        .macScreenLive(poller, active: !fullscreen)
        .fullScreenCover(isPresented: $fullscreen) {
            MacScreenFullscreen(poller: poller, hostName: hostName)
        }
    }
}

/// 全屏查看。[WP-51] 先试视频(WebRTC),不行回退截图;截图可捏合缩放(1–6×)、放大后拖动、双击复位。
/// [WP-52] 视频里可开「操控 Mac」。
struct MacScreenFullscreen: View {
    @ObservedObject var poller: MacScreenPoller
    let hostName: String?
    @StateObject private var live = MacScreenLiveModel()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var baseOffset: CGSize = .zero
    /// [duo-cap] Real safe-area insets: the video ignores the safe area, its overlays add them back
    /// per edge (iPhone Duo's island stands on one side).
    @State private var safeArea = EdgeInsets()

    private func reset() {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.28)) {
            scale = 1; baseScale = 1; offset = .zero; baseOffset = .zero
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            MacScreenLiveView(model: live, poller: poller,
                              overlayInsets: .fullscreen(top: safeArea.top, leading: safeArea.leading,
                                                         bottom: safeArea.bottom, trailing: safeArea.trailing)) {
                zoomableSnapshot
            }
                .ignoresSafeArea()
            HStack {
                MacScreenCaption(poller: poller, hostName: hostName)
                    .foregroundStyle(.white)
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.body.weight(.semibold))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel(Text("关闭"))
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 12)
        }
        .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { safeArea = $0 }
        .onAppear { live.client = poller.client }
        .statusBarHidden()
    }

    private var zoomableSnapshot: some View {
            MacScreenSurface(poller: poller)
                .scaleEffect(scale)
                .offset(offset)
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in scale = min(max(baseScale * value.magnification, 1), 6) }
                        .onEnded { _ in
                            baseScale = scale
                            if scale <= 1.01 { reset() }
                        }
                        .simultaneously(with: DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(width: baseOffset.width + value.translation.width,
                                                height: baseOffset.height + value.translation.height)
                            }
                            .onEnded { _ in baseOffset = offset })
                )
                .onTapGesture(count: 2) {
                    if scale > 1 { reset() } else {
                        withAnimation(reduceMotion ? nil : .smooth(duration: 0.28)) { scale = 2.5; baseScale = 2.5 }
                    }
                }
    }
}

/// iPad 右栏的「Mac 画面」:选哪台 Mac(多台时),画面铺满右栏,点一下全屏。
struct MacScreenColumn: View {
    @StateObject private var poller = MacScreenPoller()
    @AppStorage("leo.macScreen.hostId") private var hostId = ""
    @ObservedObject private var hosts = GatewayHostStore.shared
    @State private var hostName: String?
    @State private var fullscreen = false
    @StateObject private var live = MacScreenLiveModel()

    private func bind() {
        let target = MacScreenHosts.client(hostId: hostId.isEmpty ? nil : hostId)
        hostName = target?.host.name
        poller.client = target?.client
        live.client = target?.client
    }

    var body: some View {
        let candidates = MacScreenHosts.candidates
        Group {
            if candidates.isEmpty {
                LeoEmptyState(systemImage: "display", title: "Mac 画面",
                              message: "先在 设置 → Mac 控制台 连好一台 Mac,再在 Mac 上打开「允许手机查看屏幕」。")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        MacScreenCaption(poller: poller, hostName: hostName)
                        if candidates.count > 1 {
                            Picker("Mac", selection: $hostId) {
                                ForEach(candidates) { Text($0.name).tag($0.id) }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                        }
                        Button { fullscreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                            .accessibilityLabel(Text("全屏查看"))
                    }
                    // [WP-51] Video first (and R2 control with the pointer / keyboard); snapshots as fallback.
                    MacScreenLiveView(model: live, poller: poller, active: !fullscreen) {
                        MacScreenSurface(poller: poller)
                    }
                    .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text("视频优先;连不上时改为约每 1.5 秒一帧截图。离开这一栏或切到后台就停。")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: bind)
        .onChange(of: hostId) { _, _ in bind() }
        .onChange(of: hosts.hosts.map(\.id)) { _, _ in bind() }
        .fullScreenCover(isPresented: $fullscreen) {
            MacScreenFullscreen(poller: poller, hostName: hostName)
        }
    }
}
