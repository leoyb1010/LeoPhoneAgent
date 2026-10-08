import XCTest

/// [E1–E7] 1.57.0「产出不落孤岛」的纯逻辑部分。

final class CrossFeatureFlowTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        suite = "e157-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: E1 下一步菜单

    @MainActor func testNextStepMenuHasFiveItemsInFixedOrder() {
        XCTAssertEqual(ReplyNextStep.menu, [.collect, .quickTask, .schedule, .mac, .paperclip])
        XCTAssertEqual(ReplyNextStep.menu.map(\.title),
                       ["收进藏宝阁", "存为快捷任务", "设为定时任务", "发到 Mac", "转为服务器任务"])
        XCTAssertLessThanOrEqual(ReplyNextStep.menu.count, 5)
    }

    /// 本机优先:没连过 Paperclip 服务器,「下一步」里不出现「转为服务器任务」。
    @MainActor func testNextStepHidesServerTaskUntilPaperclipConfigured() throws {
        XCTAssertFalse(PaperclipProfile.hasSaved(defaults))
        XCTAssertEqual(ReplyNextStep.visibleMenu(paperclipConfigured: false, macFleetEnabled: true),
                       [.collect, .quickTask, .schedule, .mac])
        XCTAssertEqual(ReplyNextStep.visibleMenu(paperclipConfigured: true, macFleetEnabled: true), ReplyNextStep.menu)
        let profile = try PaperclipProfile(name: "测试", address: "https://example.com")
        defaults.set(try JSONEncoder().encode([profile]), forKey: PaperclipProfile.storageKey)
        XCTAssertTrue(PaperclipProfile.hasSaved(defaults))
    }

    /// [F] Mac 舰队默认关闭:没打开过就是关,打开后才算开。
    func testMacFleetFeatureDefaultsOff() {
        XCTAssertNil(defaults.object(forKey: MacFleetFeature.defaultsKey))
        XCTAssertFalse(MacFleetFeature.isEnabled(defaults))
        defaults.set(true, forKey: MacFleetFeature.defaultsKey)
        XCTAssertTrue(MacFleetFeature.isEnabled(defaults))
        defaults.set(false, forKey: MacFleetFeature.defaultsKey)
        XCTAssertFalse(MacFleetFeature.isEnabled(defaults))
        XCTAssertEqual(MacFleetFeature.defaultsKey, "macFleet.enabled")
        XCTAssertEqual(MacFleetFeature.disabledMessage, "Mac 舰队已关闭，到 设置 → 远程机器 打开")
    }

    /// [F] Mac 舰队关闭时「下一步」里没有「发到 Mac」;打开后恢复原样,顺序不变。
    @MainActor func testNextStepHidesMacUntilFleetEnabled() {
        XCTAssertEqual(ReplyNextStep.visibleMenu(paperclipConfigured: true, macFleetEnabled: false),
                       [.collect, .quickTask, .schedule, .paperclip])
        XCTAssertEqual(ReplyNextStep.visibleMenu(paperclipConfigured: false, macFleetEnabled: false),
                       [.collect, .quickTask, .schedule])
        XCTAssertEqual(ReplyNextStep.visibleMenu(paperclipConfigured: true, macFleetEnabled: true), ReplyNextStep.menu)
        XCTAssertFalse(ReplyNextStep.visibleMenu(paperclipConfigured: true, macFleetEnabled: false).contains(.mac))
    }

    /// 冷启动回到本机:不管上次停在哪个工作区。
    func testSelectLocalOverridesRememberedPaperclipWorkspace() {
        IOSExecutionBackend.selectPaperclip(defaults)
        XCTAssertEqual(defaults.string(forKey: IOSExecutionBackend.storageKey), IOSExecutionBackend.paperclip.rawValue)
        IOSExecutionBackend.selectLocal(defaults)
        XCTAssertEqual(defaults.string(forKey: IOSExecutionBackend.storageKey), IOSExecutionBackend.local.rawValue)
    }

    @MainActor func testSaveQuickTaskAppearsInQuickTaskList() throws {
        let quickTasks = QuickTaskStore(defaults: defaults)
        let scheduled = ScheduledTaskStore(defaults: defaults)
        let before = quickTasks.tasks.count
        let saved = try XCTUnwrap(ReplyNextStep.saveQuickTask(
            name: ReplyNextStep.quickTaskName(prompt: "帮我整理今天的待办\n按优先级排"),
            prompt: "帮我整理今天的待办\n按优先级排", scheduleMinuteOfDay: nil,
            quickTasks: quickTasks, scheduled: scheduled))
        XCTAssertNil(saved.schedule)
        XCTAssertEqual(quickTasks.tasks.count, before + 1)
        let stored = try XCTUnwrap(quickTasks.definition(for: saved.task.id))
        XCTAssertEqual(stored.name, "帮我整理今天的待办")
        XCTAssertEqual(stored.prompt, "帮我整理今天的待办\n按优先级排")
        XCTAssertFalse(stored.isBuiltIn)
        XCTAssertTrue(scheduled.tasks.isEmpty)
        // 换一个实例从同一存储读回:快捷任务列表、RunQuickTaskIntent 读的就是它。
        XCTAssertNotNil(QuickTaskStore(defaults: defaults).definition(for: saved.task.id))
    }

    @MainActor func testScheduleCreatesDailyTaskAtCurrentMinuteThatWaitsUntilTomorrow() throws {
        let quickTasks = QuickTaskStore(defaults: defaults)
        let scheduled = ScheduledTaskStore(defaults: defaults)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let now = try XCTUnwrap(calendar.date(bySettingHour: 9, minute: 41, second: 30, of: Date()))
        let minute = ReplyNextStep.minuteOfDay(now, calendar: calendar)
        XCTAssertEqual(minute, 9 * 60 + 41)
        let saved = try XCTUnwrap(ReplyNextStep.saveQuickTask(
            name: "晨报", prompt: "给我今天的晨报", scheduleMinuteOfDay: minute,
            quickTasks: quickTasks, scheduled: scheduled, now: now))
        let schedule = try XCTUnwrap(saved.schedule)
        XCTAssertEqual(schedule.quickTaskId, saved.task.id)
        XCTAssertEqual(schedule.cadence, .daily)
        XCTAssertEqual(schedule.minuteOfDay, 9 * 60 + 41)
        XCTAssertEqual(scheduled.tasks.map(\.id), [schedule.id])
        // 刚建好不该立刻跑,明天这个时刻才到点。
        XCTAssertFalse(schedule.isDue(now: now, calendar: calendar))
        XCTAssertTrue(schedule.isDue(now: now.addingTimeInterval(24 * 3600), calendar: calendar))
    }

    /// 停用期间错过的那一档、或改时间后已经过去的那一档:都不能在启用 / 保存的瞬间补跑。
    @MainActor func testReEnableOrRescheduleDoesNotFireImmediately() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let calendar = Calendar.current
        let created = try XCTUnwrap(calendar.date(bySettingHour: 7, minute: 0, second: 0, of: Date()))
        store.add(ScheduledTask(id: "t1", quickTaskId: "q", minuteOfDay: 8 * 60, isEnabled: true, now: created))
        store.setEnabled(false, id: "t1")
        let nine = try XCTUnwrap(calendar.date(bySettingHour: 9, minute: 0, second: 0, of: Date()))
        store.setEnabled(true, id: "t1", now: nine)
        XCTAssertFalse(try XCTUnwrap(store.tasks.first).isDue(now: nine), "08:00 那档在停用期间错过,启用时不补跑")

        var edited = try XCTUnwrap(store.tasks.first)
        edited.minuteOfDay = 8 * 60 + 30
        store.update(edited, now: nine)
        XCTAssertFalse(try XCTUnwrap(store.tasks.first).isDue(now: nine), "改成已过去的 08:30,保存时不跑")
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: nine))
        XCTAssertTrue(try XCTUnwrap(store.tasks.first).isDue(now: tomorrow), "明天照常")
    }

    /// 一条解不出来的任务(例如降级后遇到新版本的频率值)只跳过它,其余照旧;原始数据先备份。
    @MainActor func testUndecodableTaskDoesNotWipeTheOthers() throws {
        let raw = """
        [{"id":"good","quickTaskId":"q","cadence":"daily","minuteOfDay":480,"weekday":2,"isEnabled":true},
         {"id":"future","quickTaskId":"q","cadence":"monthly","minuteOfDay":480,"weekday":2,"isEnabled":true}]
        """
        defaults.set(Data(raw.utf8), forKey: ScheduledTaskStore.storageKey)
        let store = ScheduledTaskStore(defaults: defaults)
        XCTAssertEqual(store.tasks.map(\.id), ["good"])
        XCTAssertEqual(defaults.data(forKey: ScheduledTaskStore.storageKey + ".backup"), Data(raw.utf8))
    }

    @MainActor func testEmptyNameOrPromptIsNotSaved() {
        let quickTasks = QuickTaskStore(defaults: defaults)
        XCTAssertNil(ReplyNextStep.saveQuickTask(name: "  ", prompt: "x", scheduleMinuteOfDay: nil,
                                                 quickTasks: quickTasks, scheduled: ScheduledTaskStore(defaults: defaults)))
        XCTAssertEqual(ReplyNextStep.quickTaskName(prompt: "\n  \n"), "来自对话的任务")
    }

    @MainActor func testPromptCleanupAndHandoffTexts() {
        let raw = "今天天气怎么样\n\n<system-reminder>This message was spoken on the user's Apple Watch.</system-reminder>"
        XCTAssertEqual(ReplyNextStep.cleanPrompt(raw), "今天天气怎么样")
        XCTAssertEqual(ReplyNextStep.cleanPrompt("a<system-reminder>unterminated"), "a")
        let mac = ReplyNextStep.macTaskText(prompt: "把脚本改成并发", reply: "第一步\n\n第二步")
        XCTAssertTrue(mac.contains("我的要求:\n把脚本改成并发"))
        XCTAssertTrue(mac.contains("第一步\n第二步"))
        let long = String(repeating: "长", count: 700)
        XCTAssertEqual(ReplyNextStep.summary(long, limit: 600).count, 601)
        let note = ReplyNextStep.noteContent(prompt: "总结这篇\n文章", reply: "要点一")
        XCTAssertEqual(note.title, "总结这篇")
        XCTAssertEqual(note.body, "> 总结这篇\n> 文章\n\n要点一")
    }

    // MARK: G3 Paperclip 桥只收字符串

    @MainActor func testPaperclipHandoffTitleIsPromptAndDescriptionIsReplySummary() throws {
        let one = try XCTUnwrap(PaperclipHandoff.make(title: "  整理本周周报  ", description: "已列出 5 项"))
        XCTAssertEqual(one.title, "整理本周周报")
        XCTAssertEqual(one.description, "对话里的结果(摘要):\n已列出 5 项")
        let multi = try XCTUnwrap(PaperclipHandoff.make(title: "第一行\n第二行", description: ""))
        XCTAssertEqual(multi.title, "第一行")
        XCTAssertEqual(multi.description, "要求:\n第一行\n第二行")
        XCTAssertNil(PaperclipHandoff.make(title: " ", description: "\n"))
        let capped = try XCTUnwrap(PaperclipHandoff.make(title: String(repeating: "题", count: 500),
                                                         description: String(repeating: "述", count: 9_000)))
        XCTAssertEqual(capped.title.count, PaperclipHandoff.titleLimit)
        XCTAssertEqual(capped.description.count, PaperclipHandoff.descriptionLimit)
    }

    @MainActor func testPaperclipHandoffSwitchesWorkspaceAndPrefillsOnce() {
        defaults.set(IOSExecutionBackend.local.rawValue, forKey: IOSExecutionBackend.storageKey)
        XCTAssertTrue(PaperclipHandoff.open(title: "派个活", description: "细节", defaults: defaults))
        XCTAssertEqual(defaults.string(forKey: IOSExecutionBackend.storageKey), IOSExecutionBackend.paperclip.rawValue)
        XCTAssertEqual(PaperclipHandoff.take()?.title, "派个活")
        XCTAssertNil(PaperclipHandoff.take())
        XCTAssertFalse(PaperclipHandoff.open(title: "", description: "", defaults: defaults))
    }

    // MARK: E3 定时任务结果回写

    @MainActor func testLegacyScheduledTaskJSONDecodesWithoutNewFields() throws {
        let legacy = """
        [{"id":"t1","quickTaskId":"morningBriefing","cadence":"daily","minuteOfDay":480,
          "weekday":2,"isEnabled":true,"lastRunSlot":780000000,"lastRunAt":780000100}]
        """
        defaults.set(Data(legacy.utf8), forKey: ScheduledTaskStore.storageKey)
        let store = ScheduledTaskStore(defaults: defaults)
        let task = try XCTUnwrap(store.tasks.first)
        XCTAssertEqual(task.id, "t1")
        XCTAssertNil(task.lastSessionId)
        XCTAssertNil(task.lastResultPreview)
        XCTAssertNil(task.lastStatus)
    }

    @MainActor func testRunResultIsWrittenBackAndPersisted() throws {
        let store = ScheduledTaskStore(defaults: defaults)
        let task = ScheduledTask(quickTaskId: "morningBriefing")
        store.add(task)
        store.recordStart(id: task.id, sessionId: "s-1")
        XCTAssertNil(store.tasks.first?.lastStatus)
        let reply = "第一行\n\n" + String(repeating: "很长", count: 100)
        XCTAssertTrue(store.recordOutcome(sessionId: "s-1", status: .success, preview: reply))
        XCTAssertFalse(store.recordOutcome(sessionId: "unknown", status: .failure, preview: nil))
        let reloaded = try XCTUnwrap(ScheduledTaskStore(defaults: defaults).tasks.first)
        XCTAssertEqual(reloaded.lastSessionId, "s-1")
        XCTAssertEqual(reloaded.lastStatus, .success)
        XCTAssertEqual(reloaded.lastResultPreview?.count, ScheduledTask.previewLimit)
        XCTAssertTrue(reloaded.lastResultPreview?.hasPrefix("第一行 很长") == true)
        // 下一次开工清掉上次的结果,等新结果回写。
        store.recordStart(id: task.id, sessionId: "s-2")
        XCTAssertNil(store.tasks.first?.lastStatus)
        XCTAssertNil(store.tasks.first?.lastResultPreview)
    }

    // MARK: E5 Mac 任务回到对话

    @MainActor func testCreatePayloadCarriesPhoneSessionIdOnlyWhenGiven() {
        let with = HarnessFullAuto.createPayload(harness: "codex", cwd: "~", prompt: "x", thinking: nil,
                                                 fullAuto: true, phoneSessionId: "  chat-42  ")
        XCTAssertEqual(with["phone_session_id"] as? String, "chat-42")
        let without = HarnessFullAuto.createPayload(harness: "codex", cwd: "~", prompt: "x", thinking: nil, fullAuto: false)
        XCTAssertNil(without["phone_session_id"])
        XCTAssertNil(HarnessFullAuto.phoneSessionValue("   "))
        XCTAssertEqual(HarnessFullAuto.phoneSessionValue(String(repeating: "a", count: 300))?.count, 200)
    }

    @MainActor func testRelayCompletionWithPhoneSessionLandsInThatChatOnce() throws {
        let event: [String: Any] = ["event": "run.completed", "session_id": "hs_1",
                                    "phone_session_id": "chat-42", "output": "改好了 3 个文件"]
        let entry = try XCTUnwrap(MacResultInbox.entry(event: event, machine: "Studio", receivedAt: Date()))
        XCTAssertFalse(entry.failed)
        XCTAssertEqual(entry.noticeText, "Studio 上的 Mac 任务已完成:\n改好了 3 个文件")
        XCTAssertNil(MacResultInbox.entry(event: ["event": "run.completed", "session_id": "hs_2"],
                                          machine: "Studio", receivedAt: Date()))
        XCTAssertNil(MacResultInbox.entry(event: ["event": "approval.request", "session_id": "hs_1",
                                                  "phone_session_id": "chat-42"], machine: "Studio", receivedAt: Date()))
        MacResultInbox.record(entry, defaults: defaults)
        // 同一个 Mac 任务又结束一次:替换而不是叠加。
        var again = entry
        again.output = "又改了 1 个"
        MacResultInbox.record(again, defaults: defaults)
        XCTAssertTrue(MacResultInbox.take(phoneSessionId: "other", defaults: defaults).isEmpty)
        let taken = MacResultInbox.take(phoneSessionId: "chat-42", defaults: defaults)
        XCTAssertEqual(taken.map(\.output), ["又改了 1 个"])
        XCTAssertTrue(MacResultInbox.take(phoneSessionId: "chat-42", defaults: defaults).isEmpty)
    }

    @MainActor func testFailedRunUsesErrorAndEmptyOutputPointsToMacTask() throws {
        let failed = try XCTUnwrap(MacResultInbox.entry(
            event: ["event": "run.failed", "session_id": "hs_3", "phone_session_id": "chat-1", "error": "超时"],
            machine: "Air", receivedAt: Date()))
        XCTAssertTrue(failed.failed)
        XCTAssertEqual(failed.noticeText, "Air 上的 Mac 任务失败了:\n超时")
        var empty = failed
        empty.failed = false
        empty.output = ""
        XCTAssertEqual(empty.noticeText, "Air 上的 Mac 任务已完成。完整过程在首页的 Mac 任务里。")
    }

    // MARK: E4 手表 → iPhone

    @MainActor func testWatchContinueOnPhoneMessageRoundTrips() {
        let payload = WatchContinueOnPhone.payload(sessionId: "s-9")
        XCTAssertEqual(WatchContinueOnPhone.sessionId(from: payload), "s-9")
        XCTAssertNil(WatchContinueOnPhone.sessionId(from: ["kind": "ask", "sessionId": "s-9"]))
        XCTAssertNil(WatchContinueOnPhone.sessionId(from: ["kind": WatchContinueOnPhone.kind, "sessionId": "  "]))
        XCTAssertEqual(WatchContinueOnPhone.notificationText(sessionTitle: "周末计划", hideTitle: false).body,
                       "点开接着问:周末计划")
        XCTAssertFalse(WatchContinueOnPhone.notificationText(sessionTitle: "周末计划", hideTitle: true).body.contains("周末"))
    }

    // MARK: E6 藏宝阁交给 Agent

    @MainActor func testTreasuryInstructionPrefillsBasedOnThisItem() {
        XCTAssertEqual(TreasuryContextBuilder.agentInstruction(count: 1), "基于这条收藏：")
        XCTAssertEqual(TreasuryContextBuilder.agentInstruction(count: 3), "基于这 3 条收藏：")
    }

    // MARK: E7 接力

    @MainActor func testHandoffActivityCarriesOnlyTheSessionId() throws {
        let activity = SessionHandoff.makeActivity(sessionId: "s-7")
        XCTAssertEqual(activity.activityType, "com.leoyuan.leophoneagent.session")
        XCTAssertTrue(activity.isEligibleForHandoff)
        XCTAssertEqual(activity.userInfo?.count, 1)
        XCTAssertEqual(activity.userInfo?["sessionId"] as? String, "s-7")
    }

    @MainActor func testHandoffActivityTypeIsDeclaredInInfoPlist() throws {
        let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Info.plist")
        let data = try Data(contentsOf: plist)
        let object = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        let types = try XCTUnwrap(object?["NSUserActivityTypes"] as? [String])
        XCTAssertTrue(types.contains(SessionHandoff.activityType))
    }
}
