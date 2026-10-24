//
//  ModelCloudPrune.swift
//  MinisApp
//
//  [T-model-cloud-prune] 刷新模型列表时,服务器上已经没有的模型在 iCloud 里要删哪些记录。
//  纯字符串逻辑,编进 App 和逻辑测试两个 target(ProviderConfigStore 只在 App 里)。
//

import Foundation

enum ModelCloudPrune {
    /// 一个条目在云端可能用过的名字。
    struct EntryNames: Equatable {
        var id: String              // 规范 id(本机 DB 主键)
        var uuid: String
        var legacyColonKey: String  // "实例:模型" 旧格式
    }

    /// 被服务器列表拿掉的条目,在云端可能存在的全部记录名:规范 id、uuid、旧的冒号组合键,
    /// 以及迁移前那批随机 UUID 记录名(legacyAliases 里指向它的别名)。
    /// 仍在保留列表里的名字一律不删;删一个云端不存在的记录名是无害的。
    static func recordIds(existing: [EntryNames], kept: [EntryNames], legacyAliases: [String: String]) -> [String] {
        let keptIds = Set(kept.flatMap { [$0.id, $0.uuid] })
        let omitted = existing.filter { !keptIds.contains($0.id) && !keptIds.contains($0.uuid) }
        guard !omitted.isEmpty else { return [] }
        let omittedIds = Set(omitted.map(\.id))
        var names = Set<String>()
        for entry in omitted {
            names.insert(entry.id)
            names.insert(entry.uuid)
            if !entry.legacyColonKey.isEmpty { names.insert(entry.legacyColonKey) }
        }
        for (alias, canonical) in legacyAliases where omittedIds.contains(canonical) { names.insert(alias) }
        return names.subtracting(keptIds).sorted()
    }

    // MARK: - 拒收云端旧副本

    /// 某个服务商最近一次从它自己的 /models 拿到的完整列表。
    struct ServerList: Codable, Equatable {
        var at: Date
        var modelIds: [String]
    }

    // v2(1.86):只有用户点「清理已下线模型」才记录。v1 是以前每次自动刷新记下的,常常是网关低谷时的残缺列表,
    // 拿它拒收别的设备的模型会把刚读到的新模型删掉,升级后一律作废。
    static let serverListsKey = "leo.models.serverLists.v2"

    /// 1.73 实测:只删本机手上有的条目不够——云端还压着 400 多份旧记录,本机列表刚刷成 64,
    /// 紧接着的 iCloud 拉取就把 95 个 cursor/ 模型又插回来。拉下来的记录如果:不是自定义模型、
    /// 不在这个服务商最近一次的服务器列表里、并且比那份列表还旧——就是旧副本,拒收并删掉云端。
    /// 比列表新的放行:别的设备刚刷到、本机还没刷到的新模型不会被误删。
    static func rejectsInbound(modelId: String, isCustom: Bool, updatedAt: Date, serverList: ServerList?) -> Bool {
        guard !isCustom, let list = serverList, !list.modelIds.isEmpty else { return false }
        return updatedAt < list.at && !list.modelIds.contains(modelId)
    }

    static func serverList(for instanceId: String, defaults: UserDefaults = .standard) -> ServerList? {
        loadServerLists(defaults)[instanceId]
    }

    static func recordServerList(_ list: ServerList, for instanceId: String, defaults: UserDefaults = .standard) {
        var all = loadServerLists(defaults)
        all[instanceId] = list
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: serverListsKey) }
    }

    private static func loadServerLists(_ defaults: UserDefaults) -> [String: ServerList] {
        guard let data = defaults.data(forKey: serverListsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: ServerList].self, from: data)) ?? [:]
    }
}

// MARK: - 网关伪装 ID

/// CLIProxyAPI 在 Anthropic 风格的 /v1/models(带 anthropic-version 头)里把非 Claude 模型伪装成
/// `claude-fable-5-dd-<倒序的真实 ID>`:`claude-fable-5-dd-orp-1.3k-imik/og` 就是 `go/kimi-k3.1-pro`。
/// 原样存下来是一串乱码,所有模型都被归进「Claude」;不同设备拿到两种写法还会互相「删掉」对方的。
/// 还原成真实 ID,网关两种写法都认。与 Mac 端 `decodeCloakedModelId` 同一规则。
enum ModelIdentity {
    nonisolated(unsafe) private static let cloaked = try! Regex(#"^claude-[a-z0-9.]+(?:-[a-z0-9.]+)*?-dd-(.+)$"#)

    static func decodeCloaked(_ modelId: String) -> String {
        let trimmed = modelId.trimmingCharacters(in: .whitespaces)
        guard let match = trimmed.firstMatch(of: cloaked), let tail = match.output[1].substring else { return modelId }
        return String(tail.reversed())
    }

    static func isCloaked(_ modelId: String) -> Bool { decodeCloaked(modelId) != modelId }
}

// MARK: - 按品牌分组、最新在前

/// 模型选择器里同一服务商下的几十个模型按品牌分组(Kimi / Qwen / Claude Opus …),组内最新在前,
/// 每个品牌最新的一款标「最新」。网关返回的顺序每次都不一样,不能直接用。与 Mac 端规则一致。
enum ModelBrand {
    nonisolated(unsafe) private static let dateSuffix = try! Regex(#"[-_@](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{6})$"#)
    nonisolated(unsafe) private static let claudeVersion = try! Regex(#"^claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2}))?(?=$|[-.])"#)
    nonisolated(unsafe) private static let genericVersion = try! Regex(#"(\d+(?:\.\d+)*)(?![\d.]*[bkm](?:$|[-_]))"#)
    private static let flagship: Set<String> = ["pro", "max", "ultra", "plus", "opus", "large"]
    private static let lite: Set<String> = ["flash", "flashx", "fast", "turbo", "mini", "lite", "air", "nano",
                                            "small", "highspeed", "preview", "build", "instant", "code", "contributor"]
    private static let labels: [String: String] = [
        "gpt": "GPT", "openai-o": "OpenAI o", "claude-opus": "Claude Opus", "claude-sonnet": "Claude Sonnet",
        "claude-haiku": "Claude Haiku", "claude": "Claude", "gemini": "Gemini", "gemma": "Gemma", "deepseek": "DeepSeek",
        "glm": "GLM", "qwen": "Qwen", "kimi": "Kimi", "grok": "Grok", "minimax": "MiniMax", "mimo": "MiMo",
        "doubao": "Doubao", "hunyuan": "Hunyuan", "hy": "Hunyuan", "llama": "Llama", "mistral": "Mistral",
    ]

    private static func base(_ id: String) -> String {
        let trimmed = ModelIdentity.decodeCloaked(id).trimmingCharacters(in: .whitespaces).lowercased()
        guard let slash = trimmed.lastIndex(of: "/"), slash < trimmed.index(before: trimmed.endIndex) else { return trimmed }
        return String(trimmed[trimmed.index(after: slash)...])
    }

    /// 品牌系列键:claude-opus / gpt / kimi / qwen …;识别不了取开头的字母段。
    static func family(of id: String) -> String {
        let lower = base(id)
        if lower.hasPrefix("claude") {
            for tier in ["opus", "sonnet", "haiku"] where lower.contains(tier) { return "claude-\(tier)" }
            return "claude"
        }
        if lower.hasPrefix("gpt") || lower.hasPrefix("chatgpt") { return "gpt" }
        if lower.first == "o", lower.dropFirst().first?.isNumber == true { return "openai-o" }
        let head = lower.prefix { $0.isLetter }
        return head.isEmpty ? lower : String(head)
    }

    static func label(for family: String) -> String {
        labels[family] ?? family.prefix(1).uppercased() + family.dropFirst()
    }

    /// 紧跟品牌的版本号:kimi-k3.1-pro → [3, 0.1];claude-opus-5-5 → [5, 0.5];gpt-oss-120b → [](参数量不算)。
    /// 小版本按小数比:grok-4.20 是 4.2,排在 4.7 之前。
    static func version(of id: String) -> [Double] {
        let lower = base(id).replacing(dateSuffix, with: "")
        var parts: [Substring] = []
        if let match = lower.firstMatch(of: claudeVersion) {
            if let major = match.output[1].substring { parts.append(major) }
            if let minor = match.output[2].substring { parts.append(minor) }
        } else if let match = lower.firstMatch(of: genericVersion), let text = match.output[1].substring {
            parts = text.split(separator: ".")
        }
        return parts.enumerated().compactMap { index, part in index == 0 ? Double(part) : Double("0.\(part)") }
    }

    private static func tierScore(_ id: String) -> Double {
        base(id).split(whereSeparator: { $0 == "-" || $0 == "_" }).dropFirst().reduce(0) { score, token in
            let word = String(token)
            if flagship.contains(word) { return score + 2 }
            if lite.contains(word) { return score - 2 }
            // 版本段(3.1 / k3 / v4)不扣分,其余多余后缀轻微扣分。
            let chars = Array(word)
            let versionLike = chars.first?.isNumber == true || (chars.count > 1 && chars[0].isLetter && chars[1].isNumber)
            return versionLike ? score : score - 0.25
        }
    }

    /// 新的在前:先比版本号,同版本先旗舰(pro/max)、后 flash/lite/preview,最后按 ID 自然序。
    static func isNewer(_ left: String, than right: String) -> Bool {
        let lv = version(of: left), rv = version(of: right)
        for index in 0..<max(lv.count, rv.count) {
            let l = index < lv.count ? lv[index] : -1, r = index < rv.count ? rv[index] : -1
            if l != r { return l > r }
        }
        let lt = tierScore(left), rt = tierScore(right)
        if lt != rt { return lt > rt }
        return left.localizedStandardCompare(right) == .orderedDescending
    }

    /// 每个品牌最新的一款(没有版本号的路由别名,如 cn/fast-model,不参与)。
    static func latestIds(_ ids: [String]) -> Set<String> {
        var best: [String: String] = [:]
        for id in ids where !version(of: id).isEmpty {
            let key = family(of: id)
            if let current = best[key], !isNewer(id, than: current) { continue }
            best[key] = id
        }
        return Set(best.values)
    }

    /// 分组:有「最新」的品牌按名字排前,没版本号的别名沉底;组内最新在前。
    static func sections<T>(_ items: [T], id: (T) -> String) -> [(family: String, items: [T])] {
        var groups: [String: [T]] = [:]
        for item in items { groups[family(of: id(item)), default: []].append(item) }
        let latest = latestIds(items.map(id))
        func ranked(_ members: [T]) -> Int { members.contains { latest.contains(id($0)) } ? 0 : 1 }
        return groups
            .map { (family: $0.key, items: $0.value.sorted { isNewer(id($0), than: id($1)) }) }
            .sorted { lhs, rhs in
                let l = ranked(lhs.items), r = ranked(rhs.items)
                return l != r ? l < r : label(for: lhs.family).localizedStandardCompare(label(for: rhs.family)) == .orderedAscending
            }
    }
}

// MARK: - 刷新只增不删

extension ModelCloudPrune {
    /// 自动/手动刷新的合并规则:服务器这次给的在前(还原伪装 ID、去重),本机已有但这次没给的留在后面——
    /// 网关的列表会随上游账号可用与否起伏,某台设备刚好在低谷时刷新,不能把别的设备读到的模型删掉。
    /// `excluded`:用户明确删过的模型(墓碑),自动刷新不再加回来。删除只走用户删除或「清理已下线模型」。
    static func additiveMergeIds(fresh: [String], existing: [String], excluded: Set<String> = []) -> [String] {
        var seen = Set<String>()
        let freshIds = fresh.map(ModelIdentity.decodeCloaked).filter { !excluded.contains($0) && seen.insert($0).inserted }
        let kept = existing.map(ModelIdentity.decodeCloaked).filter { seen.insert($0).inserted }
        return freshIds + kept
    }
}
