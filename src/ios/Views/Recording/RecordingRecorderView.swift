import SwiftUI

/// [V-rec] 录音中:大号计时、电平、实时字幕,标记 / 暂停 / 停止。
struct RecordingRecorderView: View {
    @ObservedObject private var controller = RecordingController.shared
    @ObservedObject private var live = RecordingController.shared.live
    @EnvironmentObject private var navigation: RecordingNavigation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var title = ""
    @State private var stopping = false
    @State private var confirmStop = false
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(spacing: LeoTheme.Spacing.lg) {
            if let active = controller.active {
                header(active)
                LevelMeter(level: active.isPaused ? 0 : live.level, reduceMotion: reduceMotion)
                    .frame(height: 64)
                    .padding(.horizontal, LeoTheme.Spacing.lg)
                    .accessibilityHidden(true)
                captions(active)
                Spacer(minLength: 0)
                controls(active)
            } else if stopping {
                Spacer()
                ProgressView("正在保存…")
                Spacer()
            } else {
                LeoEmptyState(systemImage: "mic.slash", title: String(localized: "没有在录音"),
                              message: String(localized: "回到录音列表开始新的录音。"))
                Spacer()
            }
        }
        .padding(.vertical, LeoTheme.Spacing.md)
        .navigationTitle("录音中")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { title = controller.active.map { metaTitle($0.id) } ?? "" }
        .confirmationDialog("停止录音?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("停止并保存") { stop() }
        } message: {
            Text("停止后会自动开始转写。")
        }
    }

    private func metaTitle(_ id: String) -> String {
        controller.metadata(id)?.title ?? ""
    }

    private func header(_ active: RecordingController.Active) -> some View {
        VStack(spacing: LeoTheme.Spacing.xs) {
            TextField(String(localized: "给这段录音起个名字"), text: $title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { controller.renameActive(title) }
                .onChange(of: titleFocused) { _, focused in if !focused { controller.renameActive(title) } }
                .padding(.horizontal, LeoTheme.Spacing.lg)
            Text(TranscriptAssembler.timestamp(live.elapsed))
                .font(.system(size: 56, weight: .light, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText())
                .accessibilityLabel(Text("已录 \(TranscriptAssembler.timestamp(live.elapsed))"))
            HStack(spacing: 6) {
                Circle()
                    .fill(active.isPaused ? LeoTheme.ColorToken.secondaryText : LeoTheme.ColorToken.destructive)
                    .frame(width: 8, height: 8)
                Text(statusText(active))
                if active.highlights > 0 {
                    Text("· \(active.highlights) 个重点")
                }
            }
            .font(.subheadline)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
        }
    }

    private func statusText(_ active: RecordingController.Active) -> String {
        if active.pausedByInterruption { return String(localized: "已因来电或其他 App 暂停") }
        if active.isPaused { return String(localized: "已暂停 · 麦克风待命,不会录入") }
        return String(localized: "正在录音 · 锁屏后继续")
    }

    @ViewBuilder
    private func captions(_ active: RecordingController.Active) -> some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
            Label("实时字幕", systemImage: "captions.bubble")
                .font(.caption.weight(.semibold))
                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            ScrollViewReader { proxy in
                ScrollView {
                    Group {
                        if live.captionsAvailable {
                            (Text(live.captionFinal) + Text(live.captionVolatile).foregroundStyle(LeoTheme.ColorToken.tertiaryText))
                                .font(.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("本机语言资源未就绪时不显示实时字幕;停止后照常完整转写。")
                                .font(.footnote)
                                .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .id("captions-bottom")
                }
                .onChange(of: live.captionFinal.count + live.captionVolatile.count) { _, _ in
                    proxy.scrollTo("captions-bottom", anchor: .bottom)
                }
            }
        }
        .padding(LeoTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 220, alignment: .topLeading)
        .background(LeoTheme.ColorToken.surface, in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
        .padding(.horizontal, LeoTheme.Spacing.md)
    }

    private func controls(_ active: RecordingController.Active) -> some View {
        HStack(alignment: .center, spacing: LeoTheme.Spacing.xl) {
            roundButton(systemImage: "flag.fill", title: String(localized: "标记重点"), size: 56,
                        fill: LeoTheme.ColorToken.surface, foreground: LeoTheme.ColorToken.warning) {
                controller.markHighlight()
            }
            .disabled(active.isPaused)
            roundButton(systemImage: "stop.fill", title: String(localized: "停止"), size: 76,
                        fill: LeoTheme.ColorToken.destructive, foreground: .white) {
                confirmStop = true
            }
            .disabled(stopping)
            roundButton(systemImage: active.isPaused ? "play.fill" : "pause.fill",
                        title: active.isPaused ? String(localized: "继续") : String(localized: "暂停"), size: 56,
                        fill: LeoTheme.ColorToken.surface, foreground: LeoTheme.ColorToken.primaryText) {
                controller.togglePause()
            }
        }
        .padding(.bottom, LeoTheme.Spacing.lg)
    }

    private func roundButton(systemImage: String, title: String, size: CGFloat, fill: Color, foreground: Color,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.36, weight: .semibold))
                    .foregroundStyle(foreground)
                    .frame(width: size, height: size)
                    .background(fill, in: Circle())
                Text(title)
                    .font(.caption)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
        }
        .buttonStyle(LeoSquishButtonStyle())
        .accessibilityLabel(Text(title))
    }

    private func stop() {
        stopping = true
        Task {
            let id = await controller.stopRecording()
            stopping = false
            if let id { navigation.path = [.detail(id)] } else { navigation.path = [] }
        }
    }
}

/// 电平条:最近 40 个电平值,从右往左滚。
struct LevelMeter: View {
    let level: Float
    let reduceMotion: Bool
    @State private var history: [Float] = Array(repeating: 0, count: 40)

    var body: some View {
        GeometryReader { geo in
            HStack(alignment: .center, spacing: 3) {
                ForEach(history.indices, id: \.self) { i in
                    Capsule()
                        .fill(LeoTheme.ColorToken.destructive.opacity(0.35 + 0.65 * Double(history[i])))
                        .frame(height: max(4, geo.size.height * CGFloat(history[i])))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: level) { _, value in
            var h = history
            h.removeFirst()
            h.append(value)
            if reduceMotion { history = h } else { withAnimation(.linear(duration: 0.1)) { history = h } }
        }
    }
}
