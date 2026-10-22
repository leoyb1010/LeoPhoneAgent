import SwiftUI
import XCTest

/// [G2] 新手引导三步的版式快照:每一步都能渲染出来(浅色 / 深色)。
/// 设了环境变量 LEO_SNAPSHOT_DIR(xcodebuild 用 TEST_RUNNER_LEO_SNAPSHOT_DIR 传)时把 PNG 存过去,
/// 用来人工看图;不设时只检查能渲染。
@MainActor
final class OnboardingSnapshotTests: XCTestCase {

    private let size = CGSize(width: 440, height: 956)

    private func page(_ step: OnboardingGate.Step) -> some View {
        OnboardingStepPage(step: step, scrollable: false) {
            switch step {
            case .model:
                EmptyView()
            case .mac:
                EmptyView()
            case .firstTask:
                OnboardingUI.samplePromptCard("帮我把今天要做的事列成清单，按轻重缓急排好，再提醒我先做哪一件")
                OnboardingUI.note(Text("还没连接模型：发送时会先请你连接。"))
            }
        } actions: {
            switch step {
            case .model:
                OnboardingUI.primary("添加模型服务商", id: "a") {}
                OnboardingUI.secondary("稍后再说") {}
            case .mac:
                OnboardingUI.primary("扫码配对", id: "a") {}
                OnboardingUI.secondary("跳过这一步") {}
                OnboardingUI.back {}
            case .firstTask:
                OnboardingUI.primary("放进输入框", id: "a") {}
                OnboardingUI.secondary("直接开始") {}
                OnboardingUI.back {}
            }
        }
    }

    func testEveryStepRenders() throws {
        let dir = ProcessInfo.processInfo.environment["LEO_SNAPSHOT_DIR"].map { URL(fileURLWithPath: $0) }
        if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        for step in OnboardingGate.Step.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let view = page(step)
                    .frame(width: size.width, height: size.height)
                    .environment(\.colorScheme, scheme)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage, "step \(step) \(scheme)")
                XCTAssertEqual(image.size.width, size.width, accuracy: 1)
                if let dir, let png = image.pngData() {
                    let name = "onboarding-\(step.rawValue + 1)-\(step)-\(scheme == .dark ? "dark" : "light").png"
                    try png.write(to: dir.appendingPathComponent(name))
                }
            }
        }
    }

    func testStepCopyIsDistinct() {
        let symbols = Set(OnboardingGate.Step.allCases.map(\.symbolName))
        XCTAssertEqual(symbols.count, OnboardingGate.Step.allCases.count)
    }
}
