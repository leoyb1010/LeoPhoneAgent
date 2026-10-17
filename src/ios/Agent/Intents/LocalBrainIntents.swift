//
//  LocalBrainIntents.swift
//  MinisApp
//
//  [WP-45] Shortcuts / Siri entry points for the Foundation Models 27 system tools on
//  the local brain. Both run entirely on device (no provider, no network).
//

import AppIntents
import Foundation
import UIKit

struct AskAboutImageIntent: AppIntent {
    static var title: LocalizedStringResource = "离线问图片"
    static var description = IntentDescription("用本机模型读一张图片(截图、文档照片)并回答问题,全程不联网。")
    static var openAppWhenRun = false

    @Parameter(title: "图片", supportedContentTypes: [.image], inputConnectionBehavior: .connectToPreviousIntentResult)
    var image: IntentFile

    @Parameter(title: "问题", default: "")
    var question: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard LocalBrain.shared.availability == .ready else { throw LocalBrainIntentError.unavailable }
        guard let cg = UIImage(data: image.data)?.cgImage else { throw LocalBrainIntentError.badImage }
        guard let answer = await LocalBrain.shared.answer(aboutImage: cg, question: question) else {
            throw LocalBrainIntentError.noAnswer
        }
        return .result(value: answer, dialog: "\(answer)")
    }
}

struct FindSessionsLocallyIntent: AppIntent {
    static var title: LocalizedStringResource = "离线找会话"
    static var description = IntentDescription("按意思在这台设备的 LeoBot 会话里找,例如「上周讨论报销那次」。只看会话标题,全程不联网。")
    static var openAppWhenRun = false

    @Parameter(title: "要找什么", requestValueDialog: "想找哪段会话?")
    var query: String

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard LocalBrain.shared.availability == .ready else { throw LocalBrainIntentError.unavailable }
        guard let found = await LocalBrain.shared.findSessions(matching: query) else {
            throw LocalBrainIntentError.noAnswer
        }
        return .result(value: found, dialog: "\(found)")
    }
}

enum LocalBrainIntentError: Error, CustomLocalizedStringResourceConvertible {
    case unavailable, badImage, noAnswer

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .unavailable: return "这台设备的本机模型现在不可用(需要开启 Apple Intelligence)。"
        case .badImage: return "读不了这张图片。"
        case .noAnswer: return "本机模型没有给出回答,换个问法试试。"
        }
    }
}
