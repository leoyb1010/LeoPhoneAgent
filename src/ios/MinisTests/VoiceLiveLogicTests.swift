import XCTest

/// [H] 语音升级的纯逻辑:动态断句(H6)、双轨取舍(H2)、自动更正(H3)、度量(H4)、热词(H5)。
final class VoiceLiveLogicTests: XCTestCase {

    // MARK: - H6 动态断句

    func testEndpoint_noCaption_keepsVADDefault() {
        XCTAssertNil(VoiceEndpointing.silenceThreshold(forLiveText: ""))
        XCTAssertNil(VoiceEndpointing.silenceThreshold(forLiveText: "   "))
        XCTAssertFalse(VoiceEndpointing.shouldEndSegment(liveText: "", silence: 10))
    }

    func testEndpoint_sentenceComplete_cutsAfter0_8s() {
        for text in ["把灯打开。", "现在几点？", "Turn it off.", "好的！"] {
            XCTAssertEqual(VoiceEndpointing.silenceThreshold(forLiveText: text), VoiceEndpointing.completeSilence, text)
        }
        XCTAssertFalse(VoiceEndpointing.shouldEndSegment(liveText: "把灯打开。", silence: 0.79))
        XCTAssertTrue(VoiceEndpointing.shouldEndSegment(liveText: "把灯打开。", silence: 0.8))
    }

    func testEndpoint_midSentence_waits3s() {
        for text in ["我想先看一下，", "帮我查一下天气然后", "还有那个", "send it to the"] {
            XCTAssertEqual(VoiceEndpointing.silenceThreshold(forLiveText: text), VoiceEndpointing.midSentenceSilence, text)
        }
        XCTAssertFalse(VoiceEndpointing.shouldEndSegment(liveText: "我想先看一下，", silence: 2.9))
        XCTAssertTrue(VoiceEndpointing.shouldEndSegment(liveText: "我想先看一下，", silence: 3.0))
    }

    func testEndpoint_undecided_usesNeutral() {
        XCTAssertEqual(VoiceEndpointing.silenceThreshold(forLiveText: "帮我订明天的会议室"), VoiceEndpointing.neutralSilence)
        XCTAssertLessThan(VoiceEndpointing.neutralSilence, 5)   // 仍比 VAD 固定的约 5 秒快
        XCTAssertTrue(VoiceEndpointing.completeSilence < VoiceEndpointing.neutralSilence)
        XCTAssertTrue(VoiceEndpointing.neutralSilence < VoiceEndpointing.midSentenceSilence)
    }

    // MARK: - H2 双轨

    func testDualTrack_shortConfident_usesOnDevice() {
        XCTAssertEqual(VoiceDualTrack.route(liveText: "打开客厅灯", confidence: 0.9, segmentSeconds: 2,
                                            configuredIsOnDevice: false), .onDevice)
    }

    func testDualTrack_longOrLowConfidence_usesConfigured() {
        XCTAssertEqual(VoiceDualTrack.route(liveText: "很长的一段口述", confidence: 0.95, segmentSeconds: 8,
                                            configuredIsOnDevice: false), .configured)
        XCTAssertEqual(VoiceDualTrack.route(liveText: "含糊的一句", confidence: 0.5, segmentSeconds: 3,
                                            configuredIsOnDevice: false), .configured)
        XCTAssertEqual(VoiceDualTrack.route(liveText: "没有置信度", confidence: nil, segmentSeconds: 3,
                                            configuredIsOnDevice: false), .configured)
    }

    func testDualTrack_emptyLiveText_alwaysConfigured() {
        XCTAssertEqual(VoiceDualTrack.route(liveText: "  ", confidence: 1, segmentSeconds: 1,
                                            configuredIsOnDevice: true), .configured)
    }

    func testDualTrack_configuredIsSystem_reusesLiveResult() {
        // 配置的就是系统端侧引擎:长段也不再重跑同一个模型。
        XCTAssertEqual(VoiceDualTrack.route(liveText: "一段很长的话", confidence: nil, segmentSeconds: 30,
                                            configuredIsOnDevice: true), .onDevice)
    }

    // MARK: - H3 自动更正

    private func row(_ variants: [String], _ to: String, freq: Int, neg: Int = 0) -> ConfusionRow {
        ConfusionRow(id: UUID().uuidString, phoneticKey: "k-\(to)", variants: variants, correctedTerm: to,
                     locale: "zh", frequency: freq, negativeFeedbackCount: neg, confidence: 0.5, lastSeen: 0)
    }

    func testAutoCorrection_threshold() {
        XCTAssertFalse(VoiceAutoCorrection.isEligible(frequency: 1, negative: 0))
        XCTAssertTrue(VoiceAutoCorrection.isEligible(frequency: 2, negative: 0))
        XCTAssertFalse(VoiceAutoCorrection.isEligible(frequency: 2, negative: 1))
        XCTAssertTrue(VoiceAutoCorrection.isEligible(frequency: 3, negative: 1))
    }

    func testAutoCorrection_rulesOnlyFromConfirmedRows() {
        let rules = VoiceAutoCorrection.rules(from: [
            row(["石塘"], "食堂", freq: 2),
            row(["张山"], "张三", freq: 1),           // 只确认过一次
            row(["白"], "百", freq: 5),               // 单字变体不用
        ])
        XCTAssertEqual(rules.map(\.from), ["石塘"])
        XCTAssertEqual(rules.first?.to, "食堂")
    }

    func testAutoCorrection_appliesAndReportsPairs() {
        let rules = VoiceAutoCorrection.rules(from: [row(["石塘"], "食堂", freq: 3)])
        let (text, applied) = VoiceAutoCorrection.apply("去石塘吃饭，石塘人多", rules: rules)
        XCTAssertEqual(text, "去食堂吃饭，食堂人多")
        XCTAssertEqual(applied.count, 1)
        XCTAssertEqual(VoiceAutoCorrection.notice(for: applied), "已自动更正：石塘→食堂")
    }

    func testAutoCorrection_doesNotDoubleApplyWhenTargetContainsSource() {
        let rules = VoiceAutoCorrection.rules(from: [row(["小王"], "小王子", freq: 2)])
        let (text, applied) = VoiceAutoCorrection.apply("小王子来了，小王也来了", rules: rules)
        XCTAssertEqual(text, "小王子来了，小王子也来了")
        XCTAssertEqual(applied.count, 1)
    }

    func testAutoCorrection_noMatchLeavesTextUntouched() {
        let rules = VoiceAutoCorrection.rules(from: [row(["石塘"], "食堂", freq: 3)])
        let (text, applied) = VoiceAutoCorrection.apply("今天天气不错", rules: rules)
        XCTAssertEqual(text, "今天天气不错")
        XCTAssertTrue(applied.isEmpty)
    }

    /// 撤销 = 确认次数减一:2 次确认的规则撤销一次后不再自动替换。
    func testAutoCorrection_undoDecrementsCountInDB() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vc-\(UUID().uuidString).db")
        defer { try? FileManager.default.removeItem(at: url) }
        let db = try VoiceCorrectionDB(url: url)
        for _ in 0..<2 {
            await db.upsertConfusion(phoneticKey: "shi tang", originalVariant: "石塘", correctedTerm: "食堂",
                                     locale: "zh", contextSample: nil, asrProvider: "")
        }
        var rows = await db.autoCorrectionRows(locale: "zh", minConfirmations: VoiceAutoCorrection.minConfirmations)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.frequency, 2)
        XCTAssertEqual(VoiceAutoCorrection.rules(from: rows).first?.to, "食堂")

        await db.decrementConfusion(phoneticKey: "shi tang", correctedTerm: "食堂", locale: "zh")
        rows = await db.autoCorrectionRows(locale: "zh", minConfirmations: VoiceAutoCorrection.minConfirmations)
        XCTAssertTrue(rows.isEmpty)
        let all = await db.allConfusion(orderBy: "frequency", locale: "zh", limit: 10)
        XCTAssertEqual(all.first?.frequency, 1)
        XCTAssertEqual(all.first?.confidence ?? 0, 1.0, accuracy: 0.0001)

        // 不会减到负数
        await db.decrementConfusion(phoneticKey: "shi tang", correctedTerm: "食堂", locale: "zh")
        await db.decrementConfusion(phoneticKey: "shi tang", correctedTerm: "食堂", locale: "zh")
        let after = await db.allConfusion(orderBy: "frequency", locale: "zh", limit: 10)
        XCTAssertEqual(after.first?.frequency, 0)
    }

    // MARK: - H4 度量

    private func freshStore() -> (VoiceMetricsStore, UserDefaults, String) {
        let suite = "voice-metrics-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (VoiceMetricsStore(defaults: defaults), defaults, suite)
    }

    func testMetrics_medianOfLast20() {
        let (store, defaults, suite) = freshStore()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertNil(store.summary(.finalLatency))
        for v in 1...25 { store.record(.finalLatency, Double(v * 100)) }
        XCTAssertEqual(store.values(.finalLatency).count, VoiceMetricsStore.window)
        // 保留 600...2500,中位数 (1500+1600)/2
        XCTAssertEqual(store.summary(.finalLatency), 1550)
    }

    func testMetrics_medianOddAndEven() {
        XCTAssertEqual(VoiceMetricsStore.median([3, 1, 2]), 2)
        XCTAssertEqual(VoiceMetricsStore.median([4, 1, 3, 2]), 2.5)
        XCTAssertNil(VoiceMetricsStore.median([]))
    }

    func testMetrics_editRateIsShareOfEditedMessages() {
        let (store, defaults, suite) = freshStore()
        defer { defaults.removePersistentDomain(forName: suite) }
        for edited in [true, false, false, true] { store.record(.manualEdit, edited ? 1 : 0) }
        XCTAssertEqual(store.summary(.manualEdit), 0.5)
    }

    func testMetrics_firstAudioOnlyOncePerSend() {
        let (store, defaults, suite) = freshStore()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertNil(store.noteFirstAudio(at: 10))                 // 没有待测的发送
        store.markVoiceMessageSent(at: 100)
        XCTAssertEqual(store.noteFirstAudio(at: 101.5), 1500)
        XCTAssertNil(store.noteFirstAudio(at: 102))                // 同一次发送只记一次
        store.markVoiceMessageSent(at: 200)
        XCTAssertNil(store.noteFirstAudio(at: 200 + VoiceMetricsStore.firstAudioHorizon + 1))   // 太久不算
        XCTAssertEqual(store.values(.firstAudioLatency), [1500])
    }

    func testMetrics_rejectsInvalidSamples() {
        let (store, defaults, suite) = freshStore()
        defer { defaults.removePersistentDomain(forName: suite) }
        store.record(.finalLatency, -1)
        store.record(.finalLatency, .nan)
        XCTAssertTrue(store.values(.finalLatency).isEmpty)
    }

    // MARK: - H5 热词

    func testHotwords_rankedDedupedAndCapped() {
        let texts = (0..<80).map { "term\($0) common" } + ["common"]
        let words = VoiceHotwords.select(from: texts) { $0.split(separator: " ").map(String.init) }
        XCTAssertEqual(words.count, VoiceHotwords.limit)
        XCTAssertEqual(words.first, "common")              // 出现最多的排最前
        XCTAssertEqual(Set(words).count, words.count)
        XCTAssertEqual(words[1], "term0")                  // 同频按首次出现
    }

    func testHotwords_promptJoinsAndTruncatesOnWordBoundary() {
        XCTAssertNil(VoiceHotwords.prompt(for: []))
        XCTAssertEqual(VoiceHotwords.prompt(for: ["LeoPhoneAgent", "Paperclip"]), "LeoPhoneAgent、Paperclip")
        let many = (0..<100).map { "术语\($0)" }
        let prompt = VoiceHotwords.prompt(for: many) ?? ""
        XCTAssertLessThanOrEqual(prompt.count, VoiceHotwords.maxPromptCharacters)
        XCTAssertFalse(prompt.hasSuffix("、"))
        XCTAssertTrue(prompt.split(separator: "、").allSatisfy { $0.hasPrefix("术语") })
    }

    func testHotwords_defaultExtractorKeepsProperNouns() {
        let words = VoiceHotwords.select(from: ["今天把 CppJieba 和 LeoPhoneAgent 的代码合并一下"])
        XCTAssertTrue(words.contains("CppJieba") || words.contains("LeoPhoneAgent"), "\(words)")
        XCTAssertFalse(words.contains("今天"))
    }
}
