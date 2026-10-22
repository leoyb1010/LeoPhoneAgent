import Foundation

// [remote-ctl-ios] Leo Link 远控扩展的纯逻辑(编进 App 和 MinisTests):能力开关、模型列表、
// 各个新路由的请求体、`question.request` / `model` / `follow` 事件解析、计划审批卡的按钮。
// 契约见 src/mac/leophone/docs/specs/leo-link-remote-controls.md;界面见 HarnessSessionSettingsSheet /
// HarnessInteractionCards / GatewayViews。

// MARK: - 能力开关(`GET /v1/capabilities` 的 features)

struct HarnessFeatures: Sendable, Equatable {
    /// "leophoneagent" = LeoPhoneAgent 1.x 桥;nil = 原版 leoagent(Python)或没报。
    var server: String?
    /// 值为 true 的 feature 名。
    var flags: Set<String>

    static let models = "models"
    static let modelSwitch = "model_switch"
    static let effort = "effort"
    static let compact = "compact"
    static let rename = "rename"
    static let attachments = "attachments"
    static let askUserQuestion = "ask_user_question"
    static let follow = "follow"

    func has(_ feature: String) -> Bool { flags.contains(feature) }

    static func parse(_ obj: [String: Any]) -> HarnessFeatures {
        var flags = Set<String>()
        for (key, value) in obj["features"] as? [String: Any] ?? [:] where (value as? Bool) == true {
            flags.insert(key)
        }
        let server = (obj["server"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return HarnessFeatures(server: server, flags: flags)
    }

    /// 能列模型(launcher 的模型选择、设置页的列表)。
    var listsModels: Bool { has(Self.models) }
    /// 会话里能换模型(`POST …/model`)。
    var switchesModel: Bool { has(Self.models) && has(Self.modelSwitch) }
    /// 会话里能改推理强度(同一条 `POST …/model`)。
    var switchesEffort: Bool { has(Self.effort) && has(Self.modelSwitch) }
    var compacts: Bool { has(Self.compact) }
    var renames: Bool { has(Self.rename) }
    var acceptsAttachments: Bool { has(Self.attachments) }
    var follows: Bool { has(Self.follow) }

    /// 会话设置页有没有可显示的东西(没有就不出入口)。
    var hasSessionSettings: Bool { switchesModel || switchesEffort || compacts || renames || follows }

    /// 这台 Mac 支不支持权限模式切换,按能力判断(不看单行会话摘要):
    /// LeoPhoneAgent 桥(或显式报 `session_mode`)= 支持;原版 leoagent(有 harness_sessions、没 server)= 不支持;
    /// 别的说不准 = nil(保持现状,不落盘)。
    var sessionModeSupport: Bool? {
        if has("session_mode") || server == "leophoneagent" { return true }
        if server == nil, has("harness_sessions") { return false }
        return nil
    }
}

/// 按主机记住上次拿到的能力:控制台 / 新建页一打开就能按它显示控件,不用先闪一下。
/// 线程安全(LeoAgentClient 是 actor,界面在主线程,都会读写)。
final class HarnessFeatureCache: @unchecked Sendable {
    static let shared = HarnessFeatureCache()

    private let lock = NSLock()
    private var memory: [String: HarnessFeatures] = [:]
    private let defaults: UserDefaults
    private static let key = "leo.harness.features.v1"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func features(for hostId: String?) -> HarnessFeatures? {
        guard let hostId else { return nil }
        lock.lock(); defer { lock.unlock() }
        if let hit = memory[hostId] { return hit }
        guard let row = (defaults.dictionary(forKey: Self.key) as? [String: [String: Any]])?[hostId] else { return nil }
        let features = HarnessFeatures(server: row["server"] as? String, flags: Set(row["flags"] as? [String] ?? []))
        memory[hostId] = features
        return features
    }

    func record(_ features: HarnessFeatures, for hostId: String?) {
        guard let hostId else { return }
        lock.lock(); defer { lock.unlock() }
        guard memory[hostId] != features else { return }
        memory[hostId] = features
        var all = (defaults.dictionary(forKey: Self.key) as? [String: [String: Any]]) ?? [:]
        var row: [String: Any] = ["flags": features.flags.sorted()]
        if let server = features.server { row["server"] = server }
        all[hostId] = row
        defaults.set(all, forKey: Self.key)
    }
}

// MARK: - 权限模式支持的判定(修:单行没带 mode 就把整台 Mac 记成「不支持」)

enum HarnessModeSupport {
    /// 会话建好 / 接上后的判定。返回 nil = 没有新结论,不改也不落盘。
    /// - 摘要里有 mode:肯定支持。
    /// - 摘要里没有 mode:不说明问题(桌面任务行本来就不带 mode),只按能力判断。
    static func resolve(features: HarnessFeatures?, summaryMode: HarnessMode?) -> Bool? {
        if summaryMode != nil { return true }
        return features?.sessionModeSupport
    }
}

// MARK: - 模型与推理强度

/// [remote-ctl] 会话当前用的模型(Mac 的 provider / model id)与推理强度。
struct HarnessModelRef: Sendable, Hashable {
    let provider: String
    let model: String
    var name: String? = nil
    var effort: String? = nil

    var displayName: String { (name?.isEmpty == false ? name : nil) ?? model }

    static func parse(_ value: Any?) -> HarnessModelRef? {
        guard let obj = value as? [String: Any],
              let provider = obj["provider"] as? String, !provider.isEmpty,
              let model = obj["model"] as? String, !model.isEmpty else { return nil }
        return HarnessModelRef(provider: provider, model: model,
                               name: obj["name"] as? String,
                               effort: (obj["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 })
    }

    func sameModel(as option: HarnessModelOption) -> Bool { provider == option.provider && model == option.model }
}

/// `GET /harness/models` 的一行。
struct HarnessModelOption: Sendable, Hashable, Identifiable {
    let provider: String
    let providerName: String
    let model: String
    let name: String
    let efforts: [String]
    let defaultEffort: String?

    var id: String { provider + "\u{1F}" + model }
    var ref: HarnessModelRef { HarnessModelRef(provider: provider, model: model, name: name) }
}

struct HarnessModelCatalog: Sendable, Equatable {
    struct Group: Sendable, Equatable, Identifiable {
        let provider: String
        let providerName: String
        let models: [HarnessModelOption]
        var id: String { provider }
    }

    var models: [HarnessModelOption] = []
    /// Mac 的自动选择;没有就是 nil。
    var defaultModel: HarnessModelRef? = nil

    static func parse(_ obj: [String: Any]) -> HarnessModelCatalog {
        var seen = Set<String>()
        let models = (obj["models"] as? [[String: Any]] ?? []).compactMap { row -> HarnessModelOption? in
            guard let provider = row["provider"] as? String, !provider.isEmpty,
                  let model = row["model"] as? String, !model.isEmpty else { return nil }
            let efforts = (row["efforts"] as? [String] ?? []).filter { !$0.isEmpty }
            let option = HarnessModelOption(
                provider: provider,
                providerName: (row["provider_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? provider,
                model: model,
                name: (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? model,
                efforts: efforts,
                defaultEffort: (row["default_effort"] as? String).flatMap { $0.isEmpty ? nil : $0 })
            guard seen.insert(option.id).inserted else { return nil }
            return option
        }
        var defaultModel: HarnessModelRef?
        if let def = obj["default"] as? [String: Any] { defaultModel = HarnessModelRef.parse(def) }
        return HarnessModelCatalog(models: models, defaultModel: defaultModel)
    }

    /// 按 provider 分组,保持 Mac 给的顺序。
    var groups: [Group] {
        var order: [String] = []
        var byProvider: [String: [HarnessModelOption]] = [:]
        for option in models {
            if byProvider[option.provider] == nil { order.append(option.provider) }
            byProvider[option.provider, default: []].append(option)
        }
        return order.map { key in
            let rows = byProvider[key] ?? []
            return Group(provider: key, providerName: rows.first?.providerName ?? key, models: rows)
        }
    }

    func option(for ref: HarnessModelRef?) -> HarnessModelOption? {
        guard let ref else { return nil }
        return models.first { ref.sameModel(as: $0) }
    }
}

enum HarnessEffort {
    /// 界面上的强度名;不认得的值原样显示。
    static func title(_ raw: String) -> String {
        switch raw.lowercased() {
        case "minimal": AppLocalized("最低")
        case "low": AppLocalized("低")
        case "medium": AppLocalized("中")
        case "high": AppLocalized("高")
        case "xhigh": AppLocalized("超高")
        case "max": AppLocalized("最高")
        default: raw
        }
    }
}

// MARK: - 请求体

enum HarnessRemoteRequests {
    /// `POST …/model` 换模型(可同时给强度)。
    static func modelBody(provider: String, model: String, effort: String?) -> [String: Any] {
        var body: [String: Any] = ["provider": provider, "model": model]
        if let effort, !effort.isEmpty { body["effort"] = effort }
        return body
    }

    /// `POST …/model` 只改强度。
    static func effortBody(_ effort: String) -> [String: Any] { ["effort": effort] }

    /// `POST …/rename`;空标题不发(返回 nil)。标题过长时截断。
    static func renameBody(_ title: String) -> [String: Any]? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return ["title": String(trimmed.prefix(200))]
    }

    static func followBody(_ following: Bool) -> [String: Any] { ["following": following] }

    /// `POST …/send` 的 attachments 字段。
    static func attachmentsValue(_ attachments: [HarnessAttachment]) -> [[String: String]] {
        attachments.map { ["name": $0.name, "mime": $0.mime, "data_base64": $0.data.base64EncodedString()] }
    }

    /// `POST …/answer`。
    static func answerBody(questionId: String, answers: [HarnessQuestionAnswer]) -> [String: Any] {
        ["question_id": questionId,
         "answers": answers.map { answer -> [String: Any] in
             var row: [String: Any] = ["question": answer.question, "selected": answer.selected]
             let text = answer.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
             if !text.isEmpty { row["text"] = text }
             return row
         }]
    }

    static func declineBody(questionId: String) -> [String: Any] { ["question_id": questionId, "decline": true] }

    /// 新建会话请求体里的模型 / 强度 / thinking。
    /// - 报了 `effort` 的 Mac:发 `effort`(没选就用 thinking 的值),不再发 thinking。
    /// - 旧 Mac:照旧只发 thinking,不发 effort。
    /// - `model` 只有报了 `models` 的 Mac 才发;都不带 = Mac 自动选择。
    static func applyCreateChoices(to payload: inout [String: Any], model: HarnessModelRef?, effort: String?,
                                   thinking: String?, features: HarnessFeatures?) {
        let thinkingValue = thinking.flatMap { $0.isEmpty ? nil : $0 }
        let effortValue = effort.flatMap { $0.isEmpty ? nil : $0 }
        if features?.has(HarnessFeatures.effort) == true {
            payload.removeValue(forKey: "thinking")
            if let value = effortValue ?? thinkingValue { payload["effort"] = value }
        } else if let thinkingValue {
            payload["thinking"] = thinkingValue
        }
        if let model, features?.has(HarnessFeatures.models) == true {
            payload["model"] = ["provider": model.provider, "model": model.model]
        }
    }
}

// MARK: - 附件

struct HarnessAttachment: Sendable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let mime: String
    let data: Data

    init(id: UUID = UUID(), name: String, mime: String, data: Data) {
        self.id = id
        self.name = name
        self.mime = mime
        self.data = data
    }

    static let maxCount = 4
    /// 契约里每张的上限;实际受下面的整次发送预算约束,远比这个紧。
    static let maxBytes = 5 * 1024 * 1024
    static let allowedMimes: Set<String> = ["image/jpeg", "image/png", "image/heic", "image/webp"]

    var isWithinLimits: Bool { data.count <= Self.maxBytes && Self.allowedMimes.contains(mime) }

    /// 还能再加几张。
    static func remainingSlots(current: Int) -> Int { max(0, maxCount - current) }
}

/// 一次发送里所有附件的体积预算。整个请求体的上限按路走:中继约 1 MB(在提到 4 MB)、直连 2 MB、
/// 加密信封 4 MB,所以 iOS 把一次发送里全部附件的 base64 合计压在 1.8 MB 以内(+ 文字与 JSON 外壳)。
enum HarnessAttachmentBudget {
    static let maxTotalBase64 = 1_800_000

    /// 压缩档位:先长边 1600、质量 0.7;总量超了逐档压得更狠。
    struct Step: Equatable, Sendable {
        let maxSide: Double
        let quality: Double
    }

    static let steps: [Step] = [
        Step(maxSide: 1600, quality: 0.7),
        Step(maxSide: 1280, quality: 0.6),
        Step(maxSide: 1024, quality: 0.5),
        Step(maxSide: 800, quality: 0.45),
        Step(maxSide: 640, quality: 0.4),
    ]

    static func base64Size(_ bytes: Int) -> Int { (bytes + 2) / 3 * 4 }

    static func totalBase64(_ byteCounts: [Int]) -> Int { byteCounts.reduce(0) { $0 + base64Size($1) } }

    static func fits(_ byteCounts: [Int]) -> Bool { totalBase64(byteCounts) <= maxTotalBase64 }

    /// 第一个让全部图片合计放得下的档位;`sizesAt(i)` 返回第 i 档下每张的 JPEG 字节数(编不出来为 nil)。
    /// 全都放不下返回 nil(界面据此拒绝并说明)。
    static func firstFittingStep(_ sizesAt: (Int) -> [Int]?) -> Int? {
        steps.indices.first { index in sizesAt(index).map(fits) ?? false }
    }

    static var tooLargeMessage: String {
        AppLocalized("图片太大：一次发送的图片合计要在 1.8 MB 以内，压缩到最小仍超出。请少选几张再试。")
    }
}

// MARK: - 控制事件(值是嵌套对象,GatewayEvent 的扁平 payload 装不下,单独解析)

struct HarnessQuestionOption: Sendable, Hashable {
    let label: String
    var description: String? = nil
}

struct HarnessQuestion: Sendable, Hashable {
    let question: String
    var header: String? = nil
    let options: [HarnessQuestionOption]
    let multiSelect: Bool
}

struct HarnessQuestionRequest: Sendable, Hashable, Identifiable {
    let questionId: String
    let questions: [HarnessQuestion]
    var id: String { questionId }
}

struct HarnessQuestionAnswer: Sendable, Hashable {
    let question: String
    let selected: [String]
    var text: String? = nil
}

enum HarnessControlEvent: Sendable, Equatable {
    case question(HarnessQuestionRequest)
    /// `declined`:跳过了;`expired`:没人答,Mac 那边已过期。
    case questionResponded(questionId: String?, declined: Bool = false, expired: Bool = false)
    /// nil = Mac 说回到了自动选择(或没给模型)。
    case model(HarnessModelRef?)
    case follow(Bool)

    /// 只认这几个事件;别的返回 nil,照旧走 GatewayEvent。
    static func parse(_ obj: [String: Any]) -> HarnessControlEvent? {
        switch obj["event"] as? String {
        case "question.request":
            guard let id = obj["question_id"] as? String, !id.isEmpty else { return nil }
            let questions = (obj["questions"] as? [[String: Any]] ?? []).compactMap { row -> HarnessQuestion? in
                guard let text = row["question"] as? String, !text.isEmpty else { return nil }
                let options = (row["options"] as? [[String: Any]] ?? []).compactMap { option -> HarnessQuestionOption? in
                    guard let label = option["label"] as? String, !label.isEmpty else { return nil }
                    return HarnessQuestionOption(label: label,
                                                 description: (option["description"] as? String).flatMap { $0.isEmpty ? nil : $0 })
                }
                return HarnessQuestion(question: text,
                                       header: (row["header"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                                       options: options,
                                       multiSelect: row["multi_select"] as? Bool ?? false)
            }
            guard !questions.isEmpty else { return nil }
            return .question(HarnessQuestionRequest(questionId: id, questions: questions))
        case "question.responded":
            return .questionResponded(questionId: obj["question_id"] as? String,
                                      declined: obj["declined"] as? Bool ?? false,
                                      expired: obj["expired"] as? Bool ?? false)
        case "model":
            return .model(HarnessModelRef.parse(obj["model"]))
        case "follow":
            guard let following = obj["following"] as? Bool else { return nil }
            return .follow(following)
        default:
            return nil
        }
    }
}

/// 答题卡的本地状态:每题选了哪些、补充文字;算出提交体。
struct HarnessQuestionDraft: Equatable {
    var selected: [Int: [String]] = [:]
    var text: [Int: String] = [:]

    mutating func toggle(_ label: String, question index: Int, multiSelect: Bool) {
        var current = selected[index] ?? []
        if multiSelect {
            if let at = current.firstIndex(of: label) { current.remove(at: at) } else { current.append(label) }
        } else {
            current = current == [label] ? [] : [label]
        }
        selected[index] = current
    }

    func isSelected(_ label: String, question index: Int) -> Bool { selected[index]?.contains(label) == true }

    /// 每题至少选了一项或写了字才能提交。
    func canSubmit(_ request: HarnessQuestionRequest) -> Bool {
        request.questions.indices.allSatisfy { index in
            !(selected[index] ?? []).isEmpty
                || !(text[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    func answers(for request: HarnessQuestionRequest) -> [HarnessQuestionAnswer] {
        request.questions.enumerated().map { index, question in
            let typed = (text[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return HarnessQuestionAnswer(question: question.question, selected: selected[index] ?? [],
                                         text: typed.isEmpty ? nil : typed)
        }
    }
}

// MARK: - 审批卡的按钮

enum HarnessApprovalPresentation {
    static let planTool = "ExitPlanMode"

    static func isPlan(tool: String?) -> Bool { tool == planTool }

    /// 计划正文:Mac 给了 `plan` 用它,否则退回 description。
    static func planText(plan: String?, description: String?) -> String {
        let planText = plan?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !planText.isEmpty { return planText }
        return description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// 只显示事件给出的选项(去重、去空)。计划审批只有「批准 / 不批准」两种意思:
    /// 只留事件里有的 once / deny;两个都没有时退回事件原样的选项。
    static func visibleChoices(_ choices: [String], tool: String?) -> [String] {
        var seen = Set<String>()
        let offered = choices.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard isPlan(tool: tool) else { return offered }
        let plan = offered.filter { $0 == "once" || $0 == "deny" }
        return plan.isEmpty ? offered : plan
    }
}

// MARK: - 新建 / 接手时的默认工作目录

enum HarnessLaunchDefaults {
    /// 与首页「在哪里执行」一致:这台 Mac 上次选的目录;没选过用这台 Mac 最近会话的目录;都没有用 ~。
    static func cwd(hostId: String, saved: HomeMacDispatchTarget?, recentCwds: [String]) -> String {
        if let saved, saved.hostId == hostId, let cwd = saved.cwd, !cwd.isEmpty { return cwd }
        return HomeMacDispatchTarget.recentDirectories(recentCwds, limit: 1).first ?? "~"
    }
}

// MARK: - session.note 的过滤

enum HarnessNotePolicy {
    /// Mac 给旧版 iPhone 的「有个提问在等」文字说明:新版直接显示提问卡,这条不进时间线。
    static func hides(kind: String?) -> Bool { kind == "question_pending" }
}

// MARK: - 模型控制只对 LeoBot 会话

enum HarnessModelControlPolicy {
    /// Mac 只给 LeoBot(zcode)会话换模型 / 强度,外部 agent 的会话回 400。
    static func applies(harnessKey: String) -> Bool { harnessKey == "zcode" }

    /// 只改强度要求会话已经有模型(没有时 Mac 回 409)。
    static func canChangeEffortOnly(current: HarnessModelRef?) -> Bool { current != nil }
}

// MARK: - 关注

enum HarnessFollowPolicy {
    /// 控制台的审批本地通知:不关注的会话不发;nil(旧 Mac 不报)按关注处理。
    static func notifiesApproval(following: Bool?) -> Bool { following != false }
}
