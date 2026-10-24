import XCTest

/// [1.86] 设置首页信息架构:每一项只在一个分组里、没有空组、常用方块指向真实条目、
/// 旧条目一个不少(标题即 id,iPad 侧栏按标题记选中项,改名或丢项都会让选中落空)。
/// SettingsHomeView 只编进 App,这里读源码里的分组声明。
final class SettingsInformationArchitectureTests: XCTestCase {
    private func source() throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Views/Settings/SettingsHomeView.swift"), encoding: .utf8)
    }

    private func groupsBlock(_ s: String) throws -> String {
        let start = try XCTUnwrap(s.range(of: "static var groups: [SettingsGroup] {"))
        let end = try XCTUnwrap(s.range(of: "static let pinnedTitles", range: start.upperBound..<s.endIndex))
        return String(s[start.upperBound..<end.lowerBound])
    }

    private func titles(in block: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: #"SettingsEntry\("([^"]+)""#)
        return regex.matches(in: block, range: NSRange(block.startIndex..., in: block)).compactMap {
            Range($0.range(at: 1), in: block).map { String(block[$0]) }
        }
    }

    func testEveryEntryAppearsExactlyOnceAndNothingWasDropped() throws {
        let block = try groupsBlock(try source())
        let all = titles(in: block)
        XCTAssertEqual(all.count, Set(all).count, "同一项出现在两个分组里: \(all)")
        let expected: Set<String> = [
            "AI 服务商", "模型分组", "推理与模型", "快速判断模型", "本机模型",
            "技能", "MCP 集成", "工具开关", "手机能力与授权", "子代理", "邮箱账户", "环境变量",
            "记忆", "资料库", "人设", "Leo藏宝阁",
            "快捷任务", "自动化", "定时任务", "快捷指令模板", "Siri 指挥中心",
            "远程机器", "Apple Watch", "iCloud 同步", "远程主机(SSH·备用)",
            "权限", "外观", "后台与通知", "语音识别", "生物识别保护", "隐私与数据",
            "存储", "共享文件夹", "挂载外部文件夹", "备份与恢复", "Token 用量", "Agent 时间线", "能力自检", "日志",
            "更新记录", "新手引导", "关于",
        ]
        XCTAssertEqual(Set(all), expected)
        // Mac 控制台按开关追加在「设备与连接」最前面,定义在 macConsoleEntries 里。
        XCTAssertTrue(block.contains("SettingsGroup(id: \"devices\", title: \"设备与连接\", entries: macConsoleEntries + ["))
    }

    func testGroupsAreNonEmptyAndPinnedTilesPointAtRealEntries() throws {
        let s = try source()
        let block = try groupsBlock(s)
        let groupRegex = try NSRegularExpression(pattern: #"SettingsGroup\(id: "([a-z]+)""#)
        let ids = groupRegex.matches(in: block, range: NSRange(block.startIndex..., in: block)).compactMap {
            Range($0.range(at: 1), in: block).map { String(block[$0]) }
        }
        XCTAssertEqual(ids, ["models", "abilities", "knowledge", "automation", "devices", "general", "data", "about"])
        // 每组到下一组之间至少有一个条目。
        let pieces = block.components(separatedBy: "SettingsGroup(id:").dropFirst()
        for (id, piece) in zip(ids, pieces) {
            XCTAssertFalse(titles(in: String(piece)).isEmpty && id != "devices", "空分组: \(id)")
        }
        let all = Set(titles(in: block))
        for pinned in ["AI 服务商", "远程机器", "权限", "外观"] {
            XCTAssertTrue(all.contains(pinned), "常用方块指向不存在的条目: \(pinned)")
        }
        XCTAssertTrue(s.contains("static let pinnedTitles = [\"AI 服务商\", \"远程机器\", \"权限\", \"外观\"]"))
        // 不再有折叠手风琴,也不在每一行上做入场动画(45 行同时 onAppear)。
        XCTAssertFalse(s.contains("leoStaggerEntrance"))
        XCTAssertFalse(s.contains("@AppStorage(\"settings.group."))
        // 跳转用普通 VStack + scrollPosition,不用 LazyVStack(跳到没建出来的分组会滚不到位)。
        let body = try XCTUnwrap(s.range(of: "    var body: some View {"))
        XCTAssertFalse(String(s[body.lowerBound...].prefix(1200)).contains("LazyVStack("))
        XCTAssertTrue(s.contains(".scrollPosition(id: $currentGroup, anchor: .top)"))
    }
}
