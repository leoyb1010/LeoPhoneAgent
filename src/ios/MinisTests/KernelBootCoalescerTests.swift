import XCTest

/// [T-kernel-lazy-boot] 内核按需启动的核心保证:并发的「我要内核」合并成一次启动,
/// 已启动立即返回,失败可重试,取消某个等待者不会取消共享的那次启动。
/// 并发用手动开闸的 Gate 固定住顺序,不靠固定 sleep 猜时间。
final class KernelBootCoalescerTests: XCTestCase {
    /// 手动开闸的一道门:`wait()` 挂起直到 `open()`。
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var isOpen = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if !register(continuation) { continuation.resume() }
            }
        }

        /// 返回 true 表示已登记等待;false 表示门已经开了,调用方直接放行。
        private func register(_ continuation: CheckedContinuation<Void, Never>) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if isOpen { return false }
            waiters.append(continuation)
            return true
        }

        func open() {
            lock.lock()
            isOpen = true
            let pending = waiters
            waiters = []
            lock.unlock()
            for continuation in pending { continuation.resume() }
        }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private var flag = false
        func increment() { lock.withLock { count += 1 } }
        var value: Int { lock.withLock { count } }
        func setFlag(_ new: Bool) { lock.withLock { flag = new } }
        var flagValue: Bool { lock.withLock { flag } }
    }

    private struct BootFailure: Error {}

    /// 等条件成立(最多 5 秒),代替固定 sleep。
    private func eventually(timeout: TimeInterval = 5, _ condition: @Sendable () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        return condition()
    }

    // MARK: - 合并

    func testConcurrentCallsCoalesceIntoOneRun() async throws {
        let coalescer = KernelBootCoalescer()
        let gate = Gate()
        let counter = Counter()

        let callers = (0..<8).map { _ in
            Task {
                try await coalescer.run {
                    counter.increment()
                    await gate.wait()
                }
            }
        }
        // 1 个起头的 + 7 个并进来的,全部到齐之后才放行。
        let allJoined = await eventually { coalescer.joinCount == 7 }
        XCTAssertTrue(allJoined, "8 个并发调用应当只有 1 个自己执行,其余 7 个并进去")
        XCTAssertTrue(coalescer.isRunning)
        XCTAssertFalse(coalescer.isCompleted)

        gate.open()
        for caller in callers { try await caller.value }

        XCTAssertEqual(counter.value, 1, "启动闭包只跑一次")
        XCTAssertEqual(coalescer.runCount, 1)
        XCTAssertTrue(coalescer.isCompleted)
        XCTAssertFalse(coalescer.isRunning)
    }

    func testManyImmediateCallersStillRunOnlyOnce() async throws {
        let coalescer = KernelBootCoalescer()
        let counter = Counter()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<100 {
                group.addTask {
                    try await coalescer.run { counter.increment() }
                }
            }
            try await group.waitForAll()
        }
        XCTAssertEqual(counter.value, 1, "无论调用落在启动前、中、后,成功的启动只算一次")
        XCTAssertEqual(coalescer.runCount, 1)
        XCTAssertTrue(coalescer.isCompleted)
    }

    func testCompletedBootReturnsImmediatelyWithoutRunningAgain() async throws {
        let coalescer = KernelBootCoalescer()
        let counter = Counter()
        try await coalescer.run { counter.increment() }
        try await coalescer.run { counter.increment() }
        try await coalescer.run { counter.increment() }
        XCTAssertEqual(counter.value, 1)
        XCTAssertEqual(coalescer.runCount, 1)
        XCTAssertEqual(coalescer.joinCount, 0)
    }

    // MARK: - 失败与重试

    func testFailureIsSharedByAllWaitersAndTheNextCallRetries() async throws {
        let coalescer = KernelBootCoalescer()
        let gate = Gate()
        let counter = Counter()

        let callers = (0..<3).map { _ in
            Task {
                try await coalescer.run {
                    counter.increment()
                    await gate.wait()
                    throw BootFailure()
                }
            }
        }
        let allJoined = await eventually { coalescer.joinCount == 2 }
        XCTAssertTrue(allJoined)
        gate.open()

        for caller in callers {
            let result = await caller.result
            guard case .failure(let error) = result else {
                return XCTFail("所有等待者都该拿到同一次启动的失败")
            }
            XCTAssertTrue(error is BootFailure)
        }
        XCTAssertEqual(counter.value, 1, "失败的这一次也只跑了一回")
        XCTAssertFalse(coalescer.isCompleted, "失败不算启动成功")
        XCTAssertFalse(coalescer.isRunning, "失败后不留「正在启动」的痕迹,否则永远没法重试")

        // 失败可重试:下一次调用重新起一次,这回成功。
        try await coalescer.run { counter.increment() }
        XCTAssertEqual(counter.value, 2)
        XCTAssertEqual(coalescer.runCount, 2)
        XCTAssertTrue(coalescer.isCompleted)
    }

    func testEveryFailureRetriesAndSuccessIsFinal() async throws {
        let coalescer = KernelBootCoalescer()
        let counter = Counter()
        for attempt in 1...3 {
            do {
                try await coalescer.run {
                    counter.increment()
                    throw BootFailure()
                }
                XCTFail("第 \(attempt) 次应该失败")
            } catch {
                XCTAssertTrue(error is BootFailure)
            }
            XCTAssertEqual(coalescer.runCount, attempt)
            XCTAssertFalse(coalescer.isCompleted)
        }
        try await coalescer.run { counter.increment() }
        XCTAssertEqual(counter.value, 4)
        XCTAssertTrue(coalescer.isCompleted)
        // 成功之后不会再跑:即使后面的闭包会失败。
        try await coalescer.run { throw BootFailure() }
        XCTAssertEqual(coalescer.runCount, 4)
    }

    // MARK: - 取消

    func testCancellingWaitersDoesNotCancelTheSharedBoot() async throws {
        let coalescer = KernelBootCoalescer()
        let gate = Gate()
        let counter = Counter()
        let sawCancellation = Counter()

        let callers = (0..<2).map { _ in
            Task {
                try await coalescer.run {
                    counter.increment()
                    await gate.wait()
                    sawCancellation.setFlag(Task.isCancelled)
                }
            }
        }
        let bothArrived = await eventually { coalescer.joinCount == 1 }
        XCTAssertTrue(bothArrived)

        // 起头的和并进来的两个调用方都被取消(比如用户点了停止):启动是进程级的,不属于其中任何一个。
        for caller in callers { caller.cancel() }
        gate.open()
        for caller in callers { _ = await caller.result }

        let finished = await eventually { coalescer.isCompleted }
        XCTAssertTrue(finished, "调用方都被取消了,启动仍然要做完,后面的调用还要用")
        XCTAssertEqual(counter.value, 1)
        XCTAssertFalse(sawCancellation.flagValue, "共享的那次启动不继承调用方的取消状态")
    }
}
