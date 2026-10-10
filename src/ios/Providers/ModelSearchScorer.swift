import Foundation

/// 模型选择器的搜索相关度。纯逻辑,不改任何持久化的选择或路由。
///
/// 每个搜索词必须命中某个字段;命中档位:前缀 > 词边界 > 子串 > 模糊(按序出现)。
/// 整个查询恰好等于模型 ID 或显示名时直接排第一。服务商名称命中的权重低于模型本身。
enum ModelSearchScorer {
    struct Fields {
        var displayName: String
        var baseDisplayName: String
        var modelId: String
        var providerLabel: String
    }

    static let exactScore = 100_000
    static let prefixScore = 400
    static let wordBoundaryScore = 300
    static let substringScore = 200
    static let fuzzyScore = 100
    /// 服务商名称命中时扣掉的分数,保证同档位下模型字段优先。
    static let providerPenalty = 50

    static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                      locale: Locale(identifier: "en_US_POSIX"))
    }

    /// nil = 不匹配;数值越大越相关。空查询返回 0(全部匹配)。
    static func score(_ query: String, fields: Fields) -> Int? {
        let q = normalized(query).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return 0 }
        let modelFields = [fields.modelId, fields.displayName, fields.baseDisplayName].map(normalized)
        let provider = normalized(fields.providerLabel)
        var total = 0
        for term in q.split(whereSeparator: \.isWhitespace).map(String.init) {
            var best: Int?
            for field in modelFields {
                if let s = termScore(term, in: field, allowFuzzy: true) { best = max(best ?? s, s) }
            }
            if let s = termScore(term, in: provider, allowFuzzy: false) {
                let adjusted = s - providerPenalty
                best = max(best ?? adjusted, adjusted)
            }
            guard let best else { return nil }
            total += best
        }
        let id = modelFields[0]
        if q == id || q == modelFields[1] || q == modelFields[2] { total += exactScore }
        return total
    }

    /// 稳定排序:分数高的在前,同分保持原顺序。不匹配的条目被丢掉。
    static func rank<T>(_ items: [T], query: String, fields: (T) -> Fields) -> [T] {
        items.enumerated()
            .compactMap { pair -> (offset: Int, score: Int, item: T)? in
                guard let s = score(query, fields: fields(pair.element)) else { return nil }
                return (pair.offset, s, pair.element)
            }
            .sorted { $0.score != $1.score ? $0.score > $1.score : $0.offset < $1.offset }
            .map { $0.item }
    }

    static func termScore(_ term: String, in field: String, allowFuzzy: Bool) -> Int? {
        guard !term.isEmpty, !field.isEmpty else { return nil }
        if field.hasPrefix(term) { return prefixScore }
        var searchStart = field.startIndex
        var found = false
        while let range = field.range(of: term, range: searchStart..<field.endIndex) {
            found = true
            let before = field[field.index(before: range.lowerBound)]
            if !(before.isLetter || before.isNumber) { return wordBoundaryScore }
            searchStart = field.index(after: range.lowerBound)
        }
        if found { return substringScore }
        guard allowFuzzy, term.count >= 3, let spread = subsequenceSpread(term, in: field) else { return nil }
        // 字符挨得越紧越相关;最多扣到 1 分,永远低于子串命中。
        let gaps = spread - term.count
        return fuzzyScore - min(gaps, fuzzyScore - 1)
    }

    /// 词按顺序出现时,从第一个命中字符到最后一个命中字符的跨度;不出现返回 nil。
    private static func subsequenceSpread(_ term: String, in field: String) -> Int? {
        let t = Array(term), f = Array(field)
        var bestSpread: Int?
        for start in f.indices where f[start] == t[0] {
            var ti = 1, fi = start + 1
            while ti < t.count, fi < f.count {
                if f[fi] == t[ti] { ti += 1 }
                fi += 1
            }
            if ti == t.count {
                let spread = fi - start
                bestSpread = min(bestSpread ?? spread, spread)
            }
        }
        return bestSpread
    }
}

/// 同一服务商内新模型在前:按 models.dev 的发布日期(YYYY-MM-DD / YYYY-MM / YYYY)倒序,
/// 没有日期的排在后面,同日期或都没日期时保持原顺序。
enum ModelRecency {
    static func isValidDate(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.range(of: #"^\d{4}(-\d{2}(-\d{2})?)?$"#, options: .regularExpression) != nil
    }

    static func sortNewestFirst<T>(_ items: [T], releaseDate: (T) -> String?) -> [T] {
        items.enumerated()
            .map { (offset: $0.offset, date: releaseDate($0.element).flatMap { isValidDate($0) ? $0 : nil }, item: $0.element) }
            .sorted { a, b in
                switch (a.date, b.date) {
                case let (x?, y?) where x != y: return x > y
                case (.some, .none): return true
                case (.none, .some): return false
                default: return a.offset < b.offset
                }
            }
            .map { $0.item }
    }
}
