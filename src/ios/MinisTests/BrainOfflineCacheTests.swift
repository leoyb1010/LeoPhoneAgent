import XCTest

/// [T-brain] 离线缓存:正文页 LRU 50 页、知识卡长期保留、目录不进备份、断开即清空。
final class BrainOfflineCacheTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("BrainCache-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testEvictsOldestPageBeyondFifty() {
        let cache = BrainOfflineCache(root: root)
        XCTAssertEqual(cache.chunkPageLimit, 50)
        for i in 0..<51 {
            cache.storeChunkPage(fileId: "f\(i)", offset: 0, locator: nil, data: Data("p\(i)".utf8))
        }
        XCTAssertEqual(cache.cachedChunkPageCount, 50)
        XCTAssertNil(cache.chunkPage(fileId: "f0", offset: 0, locator: nil), "oldest page evicted")
        XCTAssertEqual(cache.chunkPage(fileId: "f50", offset: 0, locator: nil), Data("p50".utf8))
        let files = (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("pages").path)) ?? []
        XCTAssertEqual(files.count, 50)
    }

    func testReadingRefreshesRecency() {
        let cache = BrainOfflineCache(root: root, chunkPageLimit: 3)
        cache.storeChunkPage(fileId: "a", offset: 0, locator: nil, data: Data("a".utf8))
        cache.storeChunkPage(fileId: "b", offset: 0, locator: nil, data: Data("b".utf8))
        cache.storeChunkPage(fileId: "c", offset: 0, locator: nil, data: Data("c".utf8))
        XCTAssertNotNil(cache.chunkPage(fileId: "a", offset: 0, locator: nil))   // a becomes newest
        cache.storeChunkPage(fileId: "d", offset: 0, locator: nil, data: Data("d".utf8))
        XCTAssertNil(cache.chunkPage(fileId: "b", offset: 0, locator: nil))
        XCTAssertNotNil(cache.chunkPage(fileId: "a", offset: 0, locator: nil))
    }

    func testLocatorAndOffsetAreDistinctPages() {
        let cache = BrainOfflineCache(root: root)
        cache.storeChunkPage(fileId: "f", offset: 0, locator: "第3页", data: Data("loc".utf8))
        cache.storeChunkPage(fileId: "f", offset: 12, locator: nil, data: Data("off".utf8))
        XCTAssertEqual(cache.chunkPage(fileId: "f", offset: 0, locator: "第3页"), Data("loc".utf8))
        XCTAssertEqual(cache.chunkPage(fileId: "f", offset: 12, locator: nil), Data("off".utf8))
        XCTAssertNil(cache.chunkPage(fileId: "f", offset: 0, locator: nil))
    }

    func testCardsSurvivePageEviction() {
        let cache = BrainOfflineCache(root: root, chunkPageLimit: 1)
        cache.storeCard(id: "c1", data: Data("card".utf8))
        cache.storeCardList(Data("list".utf8))
        cache.storeChunkPage(fileId: "a", offset: 0, locator: nil, data: Data("a".utf8))
        cache.storeChunkPage(fileId: "b", offset: 0, locator: nil, data: Data("b".utf8))
        XCTAssertEqual(cache.card(id: "c1"), Data("card".utf8))
        XCTAssertEqual(cache.cardList(), Data("list".utf8))
    }

    func testRootExcludedFromBackup() {
        let cache = BrainOfflineCache(root: root)
        cache.storeCard(id: "c1", data: Data("x".utf8))
        XCTAssertTrue(BrainOfflineCache.isExcludedFromBackup(root))
    }

    func testClearAllRemovesEverything() {
        let cache = BrainOfflineCache(root: root)
        cache.storeCard(id: "c1", data: Data("x".utf8))
        cache.storeChunkPage(fileId: "a", offset: 0, locator: nil, data: Data("a".utf8))
        cache.clearAll()
        XCTAssertNil(cache.card(id: "c1"))
        XCTAssertEqual(cache.cachedChunkPageCount, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testDefaultRootIsInsideAppContainerApplicationSupport() {
        XCTAssertTrue(BrainOfflineCache.defaultRoot().path.contains("Application Support/BrainOffline"))
    }
}
