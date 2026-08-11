//
//  LinkPreviewFetcherSSRFTests.swift
//  MinisTests
//
//  [T-ssrf] SSRF 闸的纯逻辑测试。重点覆盖已确认过的四类绕过:
//  IPv4-mapped IPv6、非点分十进制 IP(纯十进制/八进制/十六进制)、
//  CGNAT 100.64/10、fe80::/10 全段。DNS rebinding 预检只测本地可
//  离线解析的 localhost,不引入外网依赖。
//

import XCTest

final class LinkPreviewFetcherSSRFTests: XCTestCase {

    private func blocked(_ s: String) -> Bool {
        guard let url = URL(string: s) else {
            XCTFail("URL 都构不出来: \(s)")
            return true
        }
        return LinkPreviewFetcher.isBlockedHost(url)
    }

    // MARK: - 绕过 1:IPv4-mapped IPv6

    func testIPv4MappedIPv6Blocked() {
        // 点分写法
        XCTAssertTrue(blocked("http://[::ffff:169.254.169.254]/"))   // 云元数据
        XCTAssertTrue(blocked("http://[::ffff:127.0.0.1]/"))
        XCTAssertTrue(blocked("http://[::ffff:10.0.0.1]/"))
        XCTAssertTrue(blocked("http://[::ffff:192.168.1.1]/"))
        // 纯十六进制组写法(a9fe:a9fe == 169.254.169.254)
        XCTAssertTrue(blocked("http://[::ffff:a9fe:a9fe]/"))
        XCTAssertTrue(blocked("http://[::FFFF:7F00:1]/"))            // 大写也一样
        // IPv4-compatible(::a.b.c.d)同样抠出内嵌地址
        XCTAssertTrue(blocked("http://[::127.0.0.1]/"))
        // 映射到公网的不拦
        XCTAssertFalse(blocked("http://[::ffff:8.8.8.8]/"))
        XCTAssertFalse(blocked("http://[::ffff:808:808]/"))
    }

    func testIPv6LinkLocalFullRange() {
        // fe80::/10 覆盖 fe80~febf,旧版只匹配 "fe80" 字符串前缀
        XCTAssertTrue(blocked("http://[fe80::1]/"))
        XCTAssertTrue(blocked("http://[fe9f::1]/"))
        XCTAssertTrue(blocked("http://[febf::1]/"))
        // fec0 不在 /10 内
        XCTAssertFalse(blocked("http://[fec0::1]/"))
    }

    func testIPv6BasicsStillBlocked() {
        XCTAssertTrue(blocked("http://[::1]/"))
        XCTAssertTrue(blocked("http://[::]/"))
        XCTAssertTrue(blocked("http://[fc00::1]/"))
        XCTAssertTrue(blocked("http://[fd12:3456::1]/"))
        // 公网 IPv6 放行
        XCTAssertFalse(blocked("http://[2001:4860:4860::8888]/"))
    }

    // MARK: - 绕过 2:非点分十进制 IPv4

    func testDecimalIPBlocked() {
        XCTAssertTrue(blocked("http://2130706433/"))     // 127.0.0.1
        XCTAssertTrue(blocked("http://3232235521/"))     // 192.168.0.1
        XCTAssertTrue(blocked("http://2852039166/"))     // 169.254.169.254
        XCTAssertFalse(blocked("http://134744072/"))     // 8.8.8.8,公网放行
    }

    func testOctalAndHexIPBlocked() {
        XCTAssertTrue(blocked("http://0177.0.0.1/"))         // 八进制 127
        XCTAssertTrue(blocked("http://0x7f.0.0.1/"))         // 十六进制 127
        XCTAssertTrue(blocked("http://0x7f000001/"))         // 整段十六进制
        XCTAssertTrue(blocked("http://0xA9.0376.0251.0xfe/"))   // 混合:169.254.169.254
        XCTAssertTrue(blocked("http://127.1/"))              // 2 段写法,尾段填满
        XCTAssertTrue(blocked("http://10.0.1/"))             // 3 段写法
    }

    func testNormalizedIPv4() {
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("127.0.0.1"), 0x7F00_0001)
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("2130706433"), 0x7F00_0001)
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("0177.0.0.1"), 0x7F00_0001)
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("0x7f.0.0.1"), 0x7F00_0001)
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("127.1"), 0x7F00_0001)
        XCTAssertEqual(LinkPreviewFetcher.normalizedIPv4("192.168.1"), 0xC0A8_0001)
        // 不是 IP 的返回 nil,当域名走 DNS 复核
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("example.com"))
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("1.2.3.4.5"))
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("1.2.3.256"))    // 尾段越界
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("999.1.1.1"))    // 头段越界
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("08.0.0.1"))     // 非法八进制
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("1.2..3"))       // 空段
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4(""))
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("0x"))
        XCTAssertNil(LinkPreviewFetcher.normalizedIPv4("+127.0.0.1"))   // 拒绝符号
    }

    // MARK: - 绕过 3:CGNAT 100.64.0.0/10

    func testCGNATBlocked() {
        XCTAssertTrue(blocked("http://100.64.0.0/"))
        XCTAssertTrue(blocked("http://100.100.100.100/"))
        XCTAssertTrue(blocked("http://100.127.255.255/"))
        // /10 边界外放行
        XCTAssertFalse(blocked("http://100.63.255.255/"))
        XCTAssertFalse(blocked("http://100.128.0.0/"))
    }

    // MARK: - 原有段回归

    func testClassicPrivateRangesStillBlocked() {
        XCTAssertTrue(blocked("http://127.0.0.1/"))
        XCTAssertTrue(blocked("http://10.1.2.3/"))
        XCTAssertTrue(blocked("http://172.16.0.1/"))
        XCTAssertTrue(blocked("http://172.31.255.255/"))
        XCTAssertTrue(blocked("http://192.168.1.1/"))
        XCTAssertTrue(blocked("http://169.254.169.254/"))
        XCTAssertTrue(blocked("http://0.0.0.0/"))
        XCTAssertTrue(blocked("http://224.0.0.1/"))          // 组播
        XCTAssertTrue(blocked("http://255.255.255.255/"))    // 广播
        XCTAssertTrue(blocked("http://localhost/"))
        XCTAssertTrue(blocked("http://foo.localhost/"))
        XCTAssertTrue(blocked("http://printer.local/"))
        XCTAssertTrue(blocked("http://metadata.google.internal/"))
        XCTAssertTrue(blocked("ftp://example.com/"))         // 非 http(s)
    }

    func testPublicHostsAllowed() {
        XCTAssertFalse(blocked("https://example.com/article"))
        XCTAssertFalse(blocked("https://mp.weixin.qq.com/s/abc"))
        XCTAssertFalse(blocked("http://8.8.8.8/"))
        XCTAssertFalse(blocked("http://172.32.0.1/"))    // /12 边界外
        XCTAssertFalse(blocked("http://172.15.0.1/"))
        XCTAssertFalse(blocked("http://11.0.0.1/"))
        XCTAssertFalse(blocked("http://9.9.9.9/"))
    }

    // MARK: - 绕过 4:DNS rebinding 预检(只测离线可解析的 localhost)

    func testDNSResolutionCatchesLoopbackHost() {
        // localhost 走 /etc/hosts,无网也稳定解析到 127.0.0.1 / ::1
        XCTAssertTrue(LinkPreviewFetcher.hostResolvesToBlockedAddress("localhost"))
    }
}
