//
//  SkillDraft.swift
//  MinisApp
//
//  [E2] 从这次对话生成技能:用当前模型把对话总结成草稿(名称、触发场景、步骤),
//  打开编辑页预填,由你确认后保存进技能库。这里只放与模型、界面无关的部分
//  (提示词、解析模型输出、拼 SKILL.md),编进 MinisTests。
//

import Foundation

struct SkillDraft: Identifiable, Equatable {
    var id = UUID()
    /// 技能名(短横线小写,作为技能 id)。
    var name: String
    /// 触发场景:什么时候该用它。写进 SKILL.md 的 description,模型据此判断何时调用。
    var trigger: String
    var steps: [String]

    static let transcriptLimit = 12_000

    static let systemPrompt = "你把一段对话提炼成可复用的技能草稿。只输出一个 JSON 对象,不要任何别的文字。"

    /// 发给模型的提示。对话按「用户 / 助手」逐条给出,过长时保留最近的部分。
    static func prompt(transcript: String) -> String {
        """
        把下面这次对话里完成的工作提炼成一个以后可以复用的技能草稿。要求:
        - name:英文短横线小写的技能名,2–5 个词,例如 weekly-report-summary;
        - trigger:一句中文,说明什么时候该用这个技能(触发场景);
        - steps:3–8 条中文步骤,每条一句话,可执行、可参数化,去掉这次对话里的隐私细节(人名、账号、地址、密钥)。
        只输出 JSON,例如:
        {"name": "weekly-report-summary", "trigger": "需要把本周工作整理成周报时", "steps": ["收集本周完成的事项", "按项目分组", "写成三段式周报"]}

        对话:
        \(transcript)
        """
    }

    /// 对话转成给模型看的文字;只取用户与助手的正文。
    static func transcript(_ turns: [(isUser: Bool, text: String)], limit: Int = transcriptLimit) -> String {
        let lines = turns.compactMap { turn -> String? in
            let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return (turn.isUser ? "用户:" : "助手:") + String(text.prefix(2_000))
        }
        let joined = lines.joined(separator: "\n\n")
        guard joined.count > limit else { return joined }
        return "…\n" + String(joined.suffix(limit))
    }

    /// 解析模型输出:容忍 ```json 代码块和前后多余文字;字段缺失或步骤为空返回 nil。
    static func parse(_ output: String) -> SkillDraft? {
        guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}"), start < end,
              let data = String(output[start...end]).data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let name = slug(object["name"] as? String ?? "")
        let trigger = (object["trigger"] as? String ?? object["description"] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let rawSteps: [String]
        if let list = object["steps"] as? [Any] {
            rawSteps = list.compactMap { $0 as? String }
        } else if let text = object["steps"] as? String {
            rawSteps = text.components(separatedBy: .newlines)
        } else {
            rawSteps = []
        }
        let steps = rawSteps.map(cleanStep).filter { !$0.isEmpty }
        guard !name.isEmpty, !steps.isEmpty else { return nil }
        return SkillDraft(name: name, trigger: trigger, steps: steps)
    }

    /// 编辑页里步骤是一段多行文字,一行一步;保存前拆回来。
    static func steps(fromEditorText text: String) -> [String] {
        text.components(separatedBy: .newlines).map(cleanStep).filter { !$0.isEmpty }
    }

    var stepsEditorText: String { steps.joined(separator: "\n") }

    /// 保存用的 SKILL.md(与导入的技能同一格式)。
    var skillMD: String {
        let description = trigger.isEmpty ? name : trigger
        let numbered = steps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return """
        ---
        name: \(name)
        description: \(Self.yamlInline(description))
        version: 0.1.0
        ---

        # \(name)

        ## 何时使用
        \(description)

        ## 步骤
        \(numbered)

        """
    }

    var canSave: Bool { !Self.slug(name).isEmpty && !steps.isEmpty }

    // MARK: 小工具

    /// 小写、只留字母数字和短横线。
    static func slug(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        return raw.lowercased()
            .components(separatedBy: allowed.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }

    /// 去掉行首的编号、项目符号。
    private static func cleanStep(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespaces)
        if let range = text.range(of: #"^(\d+[\.\)、]|[-*•])\s*"#, options: .regularExpression) {
            text.removeSubrange(range)
        }
        return text.trimmingCharacters(in: .whitespaces)
    }

    /// description 写成单行。本机解析器不处理 YAML 引号,所以不加引号,而是把半角冒号换成全角、
    /// 去掉开头的 YAML 指示符,保证既能被本机解析,又是合法的 YAML 普通标量。
    static func yamlInline(_ text: String) -> String {
        var line = text.components(separatedBy: .newlines).joined(separator: " ")
            .replacingOccurrences(of: ":", with: "：")
            .replacingOccurrences(of: " #", with: " ＃")
            .trimmingCharacters(in: .whitespaces)
        while let first = line.first, "-?|>!&*%@`'\"{}[]#,".contains(first) {
            line.removeFirst()
            line = line.trimmingCharacters(in: .whitespaces)
        }
        return line
    }
}
