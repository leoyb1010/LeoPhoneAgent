//
//  BrainProfileCard.swift
//  MinisApp
//
//  [E1] 「Leo 画像」知识卡:把 SOUL.md / GLOBAL.md / CORRECTIONS.md 压成 ≤ 2 KB 的一张卡,
//  发到资料库,Mac 上的 Agent 读它就知道 Leo 是谁、要避开哪些老毛病。
//  这里只放纯函数(正文拼装、裁剪、去密钥、内容指纹、发不发的判断),编进逻辑测试;
//  读文件 / 防抖 / 联网在 BrainProfilePublisher。
//

import CryptoKit
import Foundation

enum BrainProfileCard {
    static let title = "Leo 画像"
    static let category = "用户画像"
    static let header = "由 LeoBot iPhone 自动同步，Mac 上的 Agent 会读取"
    static let maxBytes = 2048
    /// 网关不认 confirmed 时退回 reference(两者都在 BrainCardDraft.allowedStatuses 里)。
    static let preferredStatus = "confirmed"
    static let fallbackStatus = "reference"

    static let correctionsHeading = "## 纠错(最高优先级,别再犯)"
    static let identityHeading = "## 身份与人格"
    static let preferencesHeading = "## 偏好与事实"
    static let emptyNote = "(暂无内容)"

    /// SOUL 一节的上限:人格只要几句话。
    static let soulMaxBytes = 400
    /// 纠错之外给 SOUL / GLOBAL 至少留的位置(它们有内容时)。
    static let soulReserve = 200
    static let globalReserve = 300
    /// 纠错太多时每条至少保留这么多字节。
    static let minCorrectionBytes = 80

    struct Inputs: Equatable {
        var soulName: String = ""
        var soulStyle: String = ""
        var soulBody: String = ""
        var global: String = ""
        /// CORRECTIONS.md 的每一行,旧 → 新。
        var corrections: [String] = []
    }

    // MARK: - 正文

    /// 拼正文。纠错优先:空间不够时先压 GLOBAL,再压 SOUL,最后才截纠错(先掉最旧的)。
    static func composeBody(_ inputs: Inputs, maxBytes: Int = maxBytes) -> String {
        let headerLine = "> " + header
        let identity = identityLines(inputs)
        let preferences = cleanLines(inputs.global)
        let corrections = inputs.corrections
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !isSecretLike($0) }

        if identity.isEmpty && preferences.isEmpty && corrections.isEmpty {
            return headerLine + "\n\n" + emptyNote
        }

        // 每节的固定开销:"\n\n" + 标题 + "\n"。
        func sectionOverhead(_ heading: String) -> Int { 2 + heading.utf8.count + 1 }
        var budget = maxBytes - headerLine.utf8.count
        if !corrections.isEmpty { budget -= sectionOverhead(correctionsHeading) }
        if !identity.isEmpty { budget -= sectionOverhead(identityHeading) }
        if !preferences.isEmpty { budget -= sectionOverhead(preferencesHeading) }

        let identityNeed = min(soulMaxBytes, joinedBytes(identity))
        let reserve = min(identityNeed, soulReserve) + min(joinedBytes(preferences), globalReserve)
        let correctionText = fitCorrections(corrections, budget: max(0, budget - reserve))
        budget -= correctionText.utf8.count

        let identityText = capLines(identity, maxBytes: max(0, min(soulMaxBytes, budget)))
        budget -= identityText.utf8.count
        let preferencesText = capLines(preferences, maxBytes: max(0, budget))

        var parts = [headerLine]
        if !correctionText.isEmpty { parts.append(correctionsHeading + "\n" + correctionText) }
        if !identityText.isEmpty { parts.append(identityHeading + "\n" + identityText) }
        if !preferencesText.isEmpty { parts.append(preferencesHeading + "\n" + preferencesText) }
        // 兜底:任何情况下都不超过上限。
        return capBytes(parts.joined(separator: "\n\n"), maxBytes: maxBytes)
    }

    /// SOUL:名字 / 风格 / 人格正文开头。默认名、空风格、空正文 → 不出这一节。
    static func identityLines(_ inputs: Inputs) -> [String] {
        var lines: [String] = []
        let name = inputs.soulName.trimmingCharacters(in: .whitespacesAndNewlines)
        let style = inputs.soulStyle.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = cleanLines(inputs.soulBody)
        if !name.isEmpty, name != "LeoBot" || !style.isEmpty || !body.isEmpty {
            lines.append("- 助手名字:\(name)")
        }
        if !style.isEmpty, !isSecretLike(style) { lines.append("- 说话风格:\(style)") }
        lines.append(contentsOf: body)
        return lines
    }

    /// 去掉空行连排、HTML 注释行和像密钥的行。
    static func cleanLines(_ text: String) -> [String] {
        var out: [String] = []
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("<!--") || isSecretLike(line) { continue }
            if line.isEmpty {
                if let last = out.last, !last.isEmpty { out.append("") }
                continue
            }
            out.append(line)
        }
        while out.last?.isEmpty == true { out.removeLast() }
        return out
    }

    /// 纠错全收;放不下时先把每条压短,再从最旧的开始丢,并注明丢了几条。
    static func fitCorrections(_ entries: [String], budget: Int) -> String {
        guard !entries.isEmpty, budget > 0 else { return "" }
        let full = entries.joined(separator: "\n")
        if full.utf8.count <= budget { return full }
        let perEntry = max(minCorrectionBytes, budget / entries.count - 1)
        var kept = entries.map { capBytes($0, maxBytes: perEntry) }
        var dropped = 0
        func render() -> String {
            let body = kept.joined(separator: "\n")
            return dropped == 0 ? body : "- (另有 \(dropped) 条较早的纠错没放下)\n" + body
        }
        while kept.count > 1, render().utf8.count > budget {
            kept.removeFirst()
            dropped += 1
        }
        return capBytes(render(), maxBytes: budget)
    }

    /// 按行截到 maxBytes;截断时最后补一行 "…"。
    static func capLines(_ lines: [String], maxBytes: Int) -> String {
        guard !lines.isEmpty, maxBytes > 0 else { return "" }
        let full = lines.joined(separator: "\n")
        if full.utf8.count <= maxBytes { return full }
        let marker = "…"
        let budget = maxBytes - marker.utf8.count - 1
        var out: [String] = []
        var used = 0
        for line in lines {
            let cost = line.utf8.count + (out.isEmpty ? 0 : 1)
            if used + cost > budget {
                // 第一行就放不下:截半行也比空着强。
                if out.isEmpty, budget > 0 { out.append(capBytes(line, maxBytes: budget, marker: "")) }
                break
            }
            out.append(line)
            used += cost
        }
        while out.last?.isEmpty == true { out.removeLast() }
        guard !out.isEmpty else { return "" }
        return out.joined(separator: "\n") + "\n" + marker
    }

    static func capBytes(_ text: String, maxBytes: Int, marker: String = "…") -> String {
        guard text.utf8.count > maxBytes else { return text }
        let budget = max(0, maxBytes - marker.utf8.count)
        var used = 0
        var end = text.startIndex
        for ch in text {
            let n = ch.utf8.count
            if used + n > budget { break }
            used += n
            end = text.index(after: end)
        }
        return String(text[..<end]) + marker
    }

    private static func joinedBytes(_ lines: [String]) -> Int {
        lines.isEmpty ? 0 : lines.joined(separator: "\n").utf8.count
    }

    // MARK: - 去密钥

    private static let secretPatterns: [NSRegularExpression] = [
        #"sk-[A-Za-z0-9_\-]{16,}"#,                       // OpenAI / Anthropic 等
        #"\bgh[pousr]_[A-Za-z0-9]{20,}"#,                 // GitHub token
        #"\bgithub_pat_[A-Za-z0-9_]{20,}"#,
        #"\b(AKIA|ASIA)[0-9A-Z]{16}\b"#,                  // AWS access key
        #"\bAIza[0-9A-Za-z_\-]{30,}"#,                    // Google API key
        #"\bxox[abprs]-[A-Za-z0-9\-]{10,}"#,              // Slack
        #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
        #"(?i)\bbearer\s+[A-Za-z0-9._\-]{16,}"#,
        #"(?i)(api[_\- ]?key|secret|token|password|passwd|pwd|密码|密钥|令牌|口令)\s*[:=：]\s*\S{6,}"#,
        #"\b[0-9a-fA-F]{32,}\b"#,                         // 长十六进制
    ].compactMap { try? NSRegularExpression(pattern: $0) }

    private static let base64Run = try? NSRegularExpression(pattern: #"[A-Za-z0-9+/=_\-]{40,}"#)

    /// 一行看起来像密钥 / 令牌 → 整行不进卡片。宁可错杀。
    static func isSecretLike(_ line: String) -> Bool {
        let range = NSRange(line.startIndex..., in: line)
        for re in secretPatterns where re.firstMatch(in: line, range: range) != nil { return true }
        guard let base64Run else { return false }
        for match in base64Run.matches(in: line, range: range) {
            guard let r = Range(match.range, in: line) else { continue }
            let run = line[r]
            // 长 base64:大小写字母和数字都有;路径(斜杠多)不算。
            let hasUpper = run.contains { $0.isUppercase }
            let hasLower = run.contains { $0.isLowercase }
            let hasDigit = run.contains { $0.isNumber }
            let slashes = run.filter { $0 == "/" }.count
            if hasUpper && hasLower && hasDigit && slashes < 3 { return true }
        }
        return false
    }

    static func stripSecrets(_ text: String) -> String {
        text.components(separatedBy: .newlines).filter { !isSecretLike($0) }.joined(separator: "\n")
    }

    // MARK: - 指纹与发布判断

    static func contentHash(_ body: String) -> String {
        SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func isEmptyProfile(_ body: String) -> Bool { body.hasSuffix(emptyNote) && !body.contains("## ") }

    /// 资料库连着、令牌有写卡权限(权限未知时照发,403 再退避)。
    static func canPublish(configured: Bool, knownScopes: Set<String>?) -> Bool {
        guard configured else { return false }
        guard let knownScopes else { return true }
        return knownScopes.contains("write:cards")
    }

    /// 内容变了才发;还没建过卡且内容为空,不建一张空卡。
    static func shouldPublish(body: String, state: State?, gateway: String) -> Bool {
        let current = state?.gateway == gateway ? state : nil
        if current == nil, isEmptyProfile(body) { return false }
        return current?.contentHash != contentHash(body)
    }

    // MARK: - [up3-ios] 认领网关上已有的卡

    /// 本机发过的卡只会是这两种状态;草稿不认(任何人都能往资料库存同名草稿)。
    static let acceptedStatuses: Set<String> = [preferredStatus, fallbackStatus]

    /// 搜索结果里可能是画像卡的(标题完全一致;搜索结果带了分类 / 状态就先按它们筛),分类对的排前面。
    static func candidateIds(_ items: [BrainSearchItem], excluding: String? = nil, limit: Int = 3) -> [String] {
        let matches = items.filter { item in
            item.isCard && item.id != excluding && !item.id.isEmpty
                && item.title.trimmingCharacters(in: .whitespacesAndNewlines) == title
                && (item.category.map { $0.isEmpty || $0 == category } ?? true)
                && (item.status.map { $0.isEmpty || acceptedStatuses.contains($0) } ?? true)
        }
        let ordered = matches.filter { $0.category == category } + matches.filter { $0.category != category }
        return Array(ordered.map(\.id).prefix(limit))
    }

    /// 取回来的整张卡:标题、分类、状态都对才接着更新它。
    static func isAdoptable(_ card: BrainCard) -> Bool {
        card.title.trimmingCharacters(in: .whitespacesAndNewlines) == title && card.category == category
            && card.status.map(acceptedStatuses.contains) == true
    }

    /// 本机没有记录(重装 / 换手机 / 记录里那张被删了)时,先找网关上已有的「Leo 画像」:Mac 认准第一张卡的 id,
    /// 再建一张新的 Mac 就读不到之后的更新。同名多张取最近更新的(和 Mac 端 pickCardRef 一致)。
    /// 搜索出错往外抛(这次不发,下次再试),不能当成「没有」去建新卡;搜索接口 404 才当没有。
    static func findExisting(excluding: String? = nil,
                             search: () async throws -> [BrainSearchItem],
                             fetch: (String) async throws -> BrainCard) async throws -> BrainCard? {
        let items: [BrainSearchItem]
        do { items = try await search() } catch BrainError.notFound { return nil }
        var found: [BrainCard] = []
        for id in candidateIds(items, excluding: excluding) {
            do {
                let card = try await fetch(id)
                if isAdoptable(card) { found.append(card) }
            } catch BrainError.notFound {
                continue
            }
        }
        return found.max { ($0.updatedAt ?? "") < ($1.updatedAt ?? "") }
    }

    /// 上次发布的结果,按网关地址区分(换了网关就当没发过)。
    struct State: Codable, Equatable {
        var gateway: String
        var cardId: String
        var version: Int
        var contentHash: String
        var status: String
    }

    static let stateKey = "leo.brain.profileCard.state"

    static func loadState(_ defaults: UserDefaults = .standard) -> State? {
        defaults.data(forKey: stateKey).flatMap { try? JSONDecoder().decode(State.self, from: $0) }
    }

    static func saveState(_ state: State?, _ defaults: UserDefaults = .standard) {
        if let state, let data = try? JSONEncoder().encode(state) {
            defaults.set(data, forKey: stateKey)
        } else {
            defaults.removeObject(forKey: stateKey)
        }
    }
}
