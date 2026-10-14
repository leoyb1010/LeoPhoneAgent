import XCTest

/// [T-mount-backoff] 失效挂载书签的自动重试退避:1 小时 → 6 小时 → 24 小时,封顶 24 小时。
/// 真机日志里两个失效书签 4 天 31 次启动每次都白等约 5 秒;退避之后,退避期内的启动直接跳过。
final class MountActivationBackoffTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let hour: TimeInterval = 3_600

    // MARK: - 退避表

    func testScheduleIsOneSixThenTwentyFourHoursCapped() {
        XCTAssertNil(MountActivationBackoff.delay(afterConsecutiveFailures: 0))
        XCTAssertNil(MountActivationBackoff.delay(afterConsecutiveFailures: -3))
        XCTAssertEqual(MountActivationBackoff.delay(afterConsecutiveFailures: 1), 1 * hour)
        XCTAssertEqual(MountActivationBackoff.delay(afterConsecutiveFailures: 2), 6 * hour)
        XCTAssertEqual(MountActivationBackoff.delay(afterConsecutiveFailures: 3), 24 * hour)
        for failures in [4, 5, 10, 99, 10_000, Int.max] {
            XCTAssertEqual(MountActivationBackoff.delay(afterConsecutiveFailures: failures), 24 * hour,
                           "第 \(failures) 次连续失败:封顶 24 小时")
        }
        XCTAssertEqual(MountActivationBackoff.maxDelay, 24 * hour)
    }

    func testDelaysNeverShrinkAsFailuresAccumulate() {
        var previous: TimeInterval = 0
        for failures in 1...30 {
            let delay = MountActivationBackoff.delay(afterConsecutiveFailures: failures) ?? 0
            XCTAssertGreaterThanOrEqual(delay, previous)
            XCTAssertLessThanOrEqual(delay, MountActivationBackoff.maxDelay)
            previous = delay
        }
    }

    // MARK: - 该不该尝试

    func testWithoutFailureHistoryAlwaysAttempts() {
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 0, lastFailureAt: nil, now: t0))
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 0, lastFailureAt: t0, now: t0),
                      "计数为 0 说明已经清零过,时间戳不算数")
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 2, lastFailureAt: nil, now: t0),
                      "有计数却没有时间(数据不全):不冻结书签,放行")
    }

    func testFirstFailureBacksOffForOneHour() {
        XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: 1, lastFailureAt: t0, now: t0))
        XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: 1, lastFailureAt: t0,
                                                            now: t0.addingTimeInterval(1 * hour - 1)))
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 1, lastFailureAt: t0,
                                                           now: t0.addingTimeInterval(1 * hour)),
                      "刚好满 1 小时就放行(边界含等号)")
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 1, lastFailureAt: t0,
                                                           now: t0.addingTimeInterval(1 * hour + 1)))
    }

    func testSecondFailureBacksOffForSixHours() {
        XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: 2, lastFailureAt: t0,
                                                            now: t0.addingTimeInterval(1 * hour)))
        XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: 2, lastFailureAt: t0,
                                                            now: t0.addingTimeInterval(6 * hour - 1)))
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 2, lastFailureAt: t0,
                                                           now: t0.addingTimeInterval(6 * hour)))
    }

    func testThirdAndLaterFailuresBackOffForTwentyFourHours() {
        for failures in [3, 4, 10, 99] {
            XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: failures, lastFailureAt: t0,
                                                                now: t0.addingTimeInterval(24 * hour - 1)),
                           "连续失败 \(failures) 次")
            XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: failures, lastFailureAt: t0,
                                                               now: t0.addingTimeInterval(24 * hour)),
                          "连续失败 \(failures) 次")
        }
    }

    func testNextAttemptIsLastFailurePlusDelay() {
        XCTAssertEqual(MountActivationBackoff.nextAttemptAt(consecutiveFailures: 1, lastFailureAt: t0),
                       t0.addingTimeInterval(1 * hour))
        XCTAssertEqual(MountActivationBackoff.nextAttemptAt(consecutiveFailures: 2, lastFailureAt: t0),
                       t0.addingTimeInterval(6 * hour))
        XCTAssertEqual(MountActivationBackoff.nextAttemptAt(consecutiveFailures: 7, lastFailureAt: t0),
                       t0.addingTimeInterval(24 * hour))
        XCTAssertNil(MountActivationBackoff.nextAttemptAt(consecutiveFailures: 0, lastFailureAt: t0))
        XCTAssertNil(MountActivationBackoff.nextAttemptAt(consecutiveFailures: 1, lastFailureAt: nil))
    }

    /// 系统时钟被往回拨过:上次失败「在未来」,按它算出的退避可能把书签冻结好几天。放行这一次。
    func testClockMovedBackwardsDoesNotFreezeTheBookmark() {
        let future = t0.addingTimeInterval(10 * 24 * hour)
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 3, lastFailureAt: future, now: t0))
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: 1, lastFailureAt: t0.addingTimeInterval(1),
                                                           now: t0))
    }

    // MARK: - 模拟几次启动

    /// 书签一直失效:启动只在退避到期后才会真的去解析,而且间隔 1h → 6h → 24h → 24h……
    func testSimulatedLaunchesOnlyResolveWhenBackoffExpires() {
        var failures = 0
        var lastFailureAt: Date?
        var attempts: [TimeInterval] = []

        // 每 30 分钟启动一次,连续跑 4 天。
        var minute: TimeInterval = 0
        while minute <= 4 * 24 * 60 {
            let now = t0.addingTimeInterval(minute * 60)
            if MountActivationBackoff.shouldAttempt(consecutiveFailures: failures, lastFailureAt: lastFailureAt, now: now) {
                attempts.append(minute / 60)       // 小时
                failures += 1                      // 解析又失败了
                lastFailureAt = now
            }
            minute += 30
        }
        // 第 0 小时试一次(失败 → 1h),第 1 小时(→ 6h),第 7 小时(→ 24h),之后每 24 小时一次。
        XCTAssertEqual(attempts, [0, 1, 7, 31, 55, 79])
        XCTAssertLessThan(attempts.count, 4 * 24 * 2, "4 天里每 30 分钟启动一次,真正去解析的次数应远少于启动次数(以前是每次都解析)")
    }

    /// 手动重试清零:计数归零、时间清空,下一次(自动)尝试立刻放行,失败了重新从 1 小时开始。
    func testManualRetryResetRestartsTheLadder() {
        var failures = 5
        var lastFailureAt: Date? = t0
        XCTAssertFalse(MountActivationBackoff.shouldAttempt(consecutiveFailures: failures, lastFailureAt: lastFailureAt,
                                                            now: t0.addingTimeInterval(2 * hour)))
        // 用户点「重试」:清零。
        failures = 0
        lastFailureAt = nil
        XCTAssertTrue(MountActivationBackoff.shouldAttempt(consecutiveFailures: failures, lastFailureAt: lastFailureAt,
                                                           now: t0.addingTimeInterval(2 * hour)))
        // 重试仍然失败:记 1 次,又是 1 小时。
        failures = 1
        lastFailureAt = t0.addingTimeInterval(2 * hour)
        XCTAssertEqual(MountActivationBackoff.nextAttemptAt(consecutiveFailures: failures, lastFailureAt: lastFailureAt),
                       t0.addingTimeInterval(3 * hour))
    }
}
