import Foundation
import Security
import SwiftUI

/// [T-jev-1.41] TypeSafe 的 Jev(System One 模型)。
///
/// 不是聊天模型:给一段状态和若干带类型的问题,70–500 毫秒返回带概率和置信度的判断。
/// 三种问题:choice(从选项里挑一个)、score(在 2–10 级里打分,可落在两级之间)、
/// noul(是 / 否的概率)。输入 $0.042 / 百万 token,输出免费。
/// 在 App 里作为 Agent 的 `jev_decide` 工具:分类、分流、打分、过滤这类"快判断"。
///
/// 接口:POST https://api.typesafe.ai/v1/systemone,`Authorization: Bearer <key>`,
/// 请求体 `{state, model, questions}`,响应 `{model, usage, answers}`
/// (与官方 SDK typesafe-sdk 0.7.1 的线格式一致)。
/// 钥匙只存本机钥匙串(仅本设备、首次解锁后可用),不进 iCloud 同步。
enum JevClient {
    static let endpoint = URL(string: "https://api.typesafe.ai/v1/systemone")!
    static let defaultModel = "jev-latest"

    private static let service = "com.leoyuan.leophoneagent.jev"
    private static let account = "api-key"

    enum JevError: LocalizedError {
        case noKey
        case badInput(String)
        case http(Int, String)
        case malformed

        var errorDescription: String? {
            switch self {
            case .noKey: return "还没有填 Jev 的 API Key(设置 → 模型 → Jev 快速判断)。"
            case .badInput(let why): return "参数不对:\(why)"
            case .http(let status, let body): return "Jev 返回 \(status):\(body)"
            case .malformed: return "Jev 返回的内容无法解析。"
            }
        }
    }

    // MARK: 钥匙

    static var hasKey: Bool { apiKey != nil }

    static var apiKey: String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let key = String(data: data, encoding: .utf8),
              !key.isEmpty else { return nil }
        return key
    }

    /// 传 nil 或空串就删除。
    @discardableResult
    static func saveKey(_ key: String?) -> Bool {
        SecItemDelete(baseQuery as CFDictionary)
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return true }
        var item = baseQuery
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    // MARK: 调用

    /// `state` 任意 JSON(字典、数组、字符串);`questions` 形如
    /// `{"name": {"type": "choice", "instructions": "...", "criteria": {"a": "...", "b": "..."}}}`。
    /// 返回原始响应字典(含 answers、usage、model)。
    static func decide(state: Any, questions: [String: Any], model: String? = nil,
                       timeout: TimeInterval = 20) async throws -> [String: Any] {
        guard let key = apiKey else { throw JevError.noKey }
        guard !questions.isEmpty else { throw JevError.badInput("至少要有一个问题") }
        for (name, raw) in questions {
            guard let q = raw as? [String: Any], let type = q["type"] as? String,
                  ["choice", "score", "noul"].contains(type) else {
                throw JevError.badInput("问题 \(name) 的 type 必须是 choice / score / noul")
            }
            if type != "noul", q["criteria"] == nil {
                throw JevError.badInput("问题 \(name) 缺少 criteria")
            }
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "state": state,
            "model": model ?? defaultModel,
            "questions": questions,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw JevError.malformed }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw JevError.http(http.statusCode, body)
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw JevError.malformed
        }
        return object
    }

    /// 连通性自检:问一个一定为"是"的问题。
    static func ping() async throws -> Double {
        let result = try await decide(
            state: ["text": "The sky is blue on a clear day."],
            questions: ["check": ["type": "noul", "instructions": "The text states a fact about the sky."]],
            timeout: 12)
        let answers = result["answers"] as? [String: Any]
        let check = answers?["check"] as? [String: Any]
        guard let noul = (check?["noul"] as? NSNumber)?.doubleValue else { throw JevError.malformed }
        return noul
    }
}

// MARK: - 设置页

struct JevSettingsView: View {
    @State private var keyInput = ""
    @State private var hasKey = JevClient.hasKey
    @State private var testing = false
    @State private var testResult: String?

    var body: some View {
        Form {
            Section {
                if hasKey {
                    Label("已填好,只存在这台设备的钥匙串里", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    Button(testing ? "测试中…" : "测一下") { Task { await test() } }
                        .disabled(testing)
                    Button("删除 Key", role: .destructive) {
                        JevClient.saveKey(nil)
                        hasKey = false
                        testResult = nil
                    }
                } else {
                    SecureField("粘贴 TypeSafe API Key", text: $keyInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("保存并测试") {
                        guard JevClient.saveKey(keyInput) else {
                            testResult = "保存失败,请重试。"
                            return
                        }
                        keyInput = ""
                        hasKey = JevClient.hasKey
                        Task { await test() }
                    }
                    .disabled(keyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let testResult {
                    Text(testResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Jev 是 TypeSafe 的\"快判断\"模型:不写文字,只回答带概率的选择、打分和是否,几百毫秒出结果、成本极低。填好后 Agent 会多一个 jev_decide 工具,用来分类、分流、打分和过滤。Key 在 console.typesafe.ai 申请。")
            }
        }
        .navigationTitle("Jev 快速判断")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func test() async {
        testing = true
        defer { testing = false }
        let start = Date()
        do {
            let yes = try await JevClient.ping()
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            testResult = "连接正常:\(ms) 毫秒,判断\"是\"的概率 \(String(format: "%.2f", yes))。"
        } catch {
            testResult = error.localizedDescription
        }
    }
}
