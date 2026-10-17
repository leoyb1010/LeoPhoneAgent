import SwiftUI

/// [WP-40] 一条用户思考规则的编辑页(新建 / 编辑),参照 OpenMinis v1.14
/// `ThinkingRuleEditorView`,按我们的规则模型(全局列表 + 最高档 + 可选钉到服务商)改写。
///
/// 和原来挤在列表行里的三个控件相比,多了三样最能防错的东西:
/// - 「会命中」:当前已配置的模型里哪些会被这条规则匹配 —— 模式写错时规则静默不生效;
/// - 「请求预览」:High 档时这条规则往请求里写什么;
/// - 作用范围:只对某个服务商生效(中转站各写各的思考开关时用得上)。
struct ThinkingRuleEditorView: View {
    /// nil = 新建。
    let existing: ThinkingRule?
    let onSave: (ThinkingRule) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = ProviderConfigStore.shared

    /// 编辑器里的写法选项。命令行能写出编辑器不提供的写法(booleanToggle 等),
    /// 这类规则显示为「保持当前写法」,保存时原样保留,绝不悄悄改成「跟随内置」。
    private enum WireOption: Hashable {
        case preset(ThinkingWireChoice)
        case keepOriginal
    }

    @State private var pattern = ""
    @State private var label = ""
    @State private var maxLevel: ThinkingLevel?
    @State private var wire: WireOption = .preset(.followBuiltIn)
    @State private var providerId = ""
    @State private var error: String?

    private var originalWire: ThinkingWireFormat? { existing?.wireFormat }
    private var originalIsUnrepresentable: Bool {
        guard let original = originalWire else { return false }
        return ThinkingWireChoice(original) == .followBuiltIn
    }

    private var resolvedWire: ThinkingWireFormat? {
        switch wire {
        case .preset(let choice): return choice.wireFormat
        case .keepOriginal: return originalWire
        }
    }

    private var draft: Result<ThinkingRule, ThinkingRuleEdits.EditError> {
        Result {
            try ThinkingRuleEdits.makeRule(pattern: pattern, maxLevel: maxLevel, wireFormat: resolvedWire,
                                           label: label, providerInstanceId: providerId,
                                           reasoningEcho: existing?.reasoningEcho, id: existing?.id)
        }.mapError { $0 as? ThinkingRuleEdits.EditError ?? .nothingToDo }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("模型 id 前缀,如 gpt-5.7", text: $pattern)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("名称(可选)", text: $label)
                        .autocorrectionDisabled()
                } header: {
                    Text("匹配哪些模型")
                } footer: {
                    Text("不带 * 时按前缀匹配(gpt-5.7 也匹配 gpt-5.7-mini);* 匹配任意字符。不分大小写,「.」和「-」视为相同。")
                }

                if case .success(let rule) = draft {
                    let hits = ThinkingRuleEdits.matchedModelIds(rule, among: store.modelEntries.map(\.model.id))
                    Section("会命中") {
                        if hits.isEmpty {
                            Label("当前已配置的模型里没有匹配的", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                        } else {
                            ForEach(hits, id: \.self) { Text($0).font(.callout.monospaced()) }
                        }
                    }
                }

                Section {
                    Picker("最高档", selection: $maxLevel) {
                        Text("不限制(跟随内置)").tag(ThinkingLevel?.none)
                        ForEach(ThinkingLevel.allCases.filter { $0 != .off }, id: \.self) { level in
                            Text(level.displayName).tag(ThinkingLevel?.some(level))
                        }
                    }
                    Picker("思考参数", selection: $wire) {
                        ForEach(ThinkingWireChoice.allCases, id: \.self) { choice in
                            Text(choice.title).tag(WireOption.preset(choice))
                        }
                        if originalIsUnrepresentable, let original = originalWire {
                            Text("保持当前写法(\(original.displaySummary))").tag(WireOption.keepOriginal)
                        }
                    }
                    Picker("作用范围", selection: $providerId) {
                        Text("所有服务商").tag("")
                        ForEach(store.instances, id: \.id) { inst in
                            Text(inst.label).tag(inst.id)
                        }
                    }
                } header: {
                    Text("规则")
                } footer: {
                    Text("读不到内置档时在这里写最高档,否则界面显示未知,不会默默降级。「思考参数」只作用于 OpenAI 兼容接口,用来纠正中转站对思考开关的写法,留在「跟随内置」最稳妥。最高档对所有服务商生效;作用范围只限制思考参数。")
                }

                if let preview = requestPreview {
                    Section {
                        Text(preview)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    } header: {
                        Text("请求预览(High 档)")
                    }
                }

                if case .failure(let e) = draft, !pattern.trimmingCharacters(in: .whitespaces).isEmpty {
                    Section { Text(message(for: e)).foregroundStyle(.red) }
                }
            }
            .navigationTitle(existing == nil ? "新建规则" : "编辑规则")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if case .success(let rule) = draft {
                            onSave(rule)
                            dismiss()
                        }
                    }
                    .disabled({ if case .success = draft { return false } else { return true } }())
                }
            }
            .onAppear(perform: seed)
        }
    }

    /// 思考参数写法在 High 档时往请求体里加的字段。「跟随内置」没有可预览的固定形态。
    private var requestPreview: String? {
        guard let format = resolvedWire else { return nil }
        var body: [String: Any] = [:]
        let ctx = ThinkingResolveContext(
            modelId: pattern.isEmpty ? "example-model" : pattern.replacingOccurrences(of: "*", with: "x"),
            supportsReasoning: true, declaredEffortValues: nil, level: .high, maxTokens: 8192,
            isOpenRouter: false, usesUnifiedReasoningEffort: false, isMistral: false, offEffort: nil,
            userRules: [ThinkingRule(kind: .custom, scope: .allModels, wireFormat: format, label: "preview")])
        _ = ThinkingRuleResolver.apply(to: &body, ctx: ctx)
        guard !body.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .prettyPrinted]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func message(for error: ThinkingRuleEdits.EditError) -> String {
        switch error {
        case .nothingToDo: return "至少设置「最高档」或「思考参数」其中一项,否则这条规则什么都不做。"
        case .emptyPattern: return "请填写模型 id 前缀。"
        default: return error.description
        }
    }

    private func seed() {
        guard let rule = existing else { return }
        pattern = rule.patternText
        label = rule.label == rule.patternText ? "" : rule.label
        maxLevel = rule.maxLevel
        providerId = rule.providerInstanceId ?? ""
        wire = originalIsUnrepresentable ? .keepOriginal : .preset(ThinkingWireChoice(rule.wireFormat))
    }
}
