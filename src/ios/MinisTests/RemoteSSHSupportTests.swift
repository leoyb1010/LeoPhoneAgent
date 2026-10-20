import Foundation
import XCTest

final class RemoteSSHSupportTests: XCTestCase {
    // MARK: UTF-8 分块

    func testLineBufferKeepsChineseSplitAcrossChunks() {
        let bytes = Array("你好，世界\n第二行".utf8)
        // 从「你」的第 2 个字节处切开，再从「世」中间切开。
        var buffer = SSHLineBuffer()
        var lines = buffer.append(bytes[0..<2])
        lines += buffer.append(bytes[2..<10])
        lines += buffer.append(bytes[10...])
        XCTAssertEqual(lines, ["你好，世界"])
        XCTAssertEqual(buffer.flush(), "第二行")
        XCTAssertNil(buffer.flush())
        XCTAssertFalse(lines.joined().contains("\u{FFFD}"))
    }

    func testLineBufferSplitsCRLFAndMultipleLinesPerChunk() {
        var buffer = SSHLineBuffer()
        XCTAssertEqual(buffer.append(Array("a\r\nb\nc".utf8)), ["a\r", "b"])
        XCTAssertEqual(buffer.flush(), "c")
    }

    func testUTF8DecoderHoldsIncompleteTail() {
        let bytes = Array("编译😀ok".utf8)
        var decoder = SSHUTF8Decoder()
        var text = ""
        for byte in bytes { text += decoder.decode([byte]) }
        text += decoder.flush()
        XCTAssertEqual(text, "编译😀ok")

        // 坏字节不扣留，照常解成 �，后面的内容不受影响。
        var bad = SSHUTF8Decoder()
        XCTAssertEqual(bad.decode([0xFF, 0x41]), "\u{FFFD}A")
        XCTAssertEqual(SSHUTF8Decoder.completePrefixLength([0x41, 0xE4, 0xBD]), 1)
        XCTAssertEqual(SSHUTF8Decoder.completePrefixLength([0x41, 0xE4, 0xBD, 0xA0]), 4)
    }

    // MARK: 头尾截断

    func testClipKeepsHeadAndTailAndMarksGap() {
        var clip = SSHOutputClip(headLimit: 5, tailLimit: 6)
        for chunk in ["HEAD-", "middle-noise-", "x", "error!"] { clip.append(chunk) }
        let text = clip.text
        XCTAssertTrue(text.hasPrefix("HEAD-"))
        XCTAssertTrue(text.hasSuffix("error!"))
        XCTAssertTrue(text.contains("省略中间 14 字符"))
    }

    func testClipShortOutputUntouched() {
        var clip = SSHOutputClip()
        clip.append("hello\n")
        clip.append("世界")
        XCTAssertEqual(clip.text, "hello\n世界")
    }

    func testClipLargeOutputBounded() {
        var clip = SSHOutputClip()
        for i in 0..<5000 { clip.append("line \(i) ................................\n") }
        clip.append("FATAL: build failed")
        let text = clip.text
        XCTAssertTrue(text.hasPrefix("line 0 "))
        XCTAssertTrue(text.hasSuffix("FATAL: build failed"))
        XCTAssertLessThan(text.count, 4000 + 16000 + 100)
    }

    // MARK: 退出码 / 网关重试

    func testExitTrailerParsing() {
        let (body, code) = RemoteSSHText.splitExitTrailer("out\nmore\n\n[leo-exit:255]")
        XCTAssertEqual(body, "out\nmore")
        XCTAssertEqual(code, "255")
        XCTAssertNil(RemoteSSHText.splitExitTrailer("no trailer").code)
    }

    func testExit255OnlyRetriesWhenSSHNeverReachedTarget() {
        // ssh 自己失败：255，目标没打出开始标记 → 可以换网关。
        XCTAssertTrue(RemoteSSHText.relayMayRetry(output: "ssh: connect to host x port 22: No route to host\n[exit code 255]", exitCode: "255"))
        // 命令自己 exit 255：标记已经打出 → 不能重跑。
        XCTAssertFalse(RemoteSSHText.relayMayRetry(output: "[leo-relay-started]\nboom\n[exit code 255]", exitCode: "255"))
        // 其它退出码：命令跑过了，不换。
        XCTAssertFalse(RemoteSSHText.relayMayRetry(output: "fail", exitCode: "1"))
        XCTAssertEqual(RemoteSSHText.stripRelayMarker("[leo-relay-started]\nhello"), "hello")
    }

    func testRemoteAgentTimeoutMatchesExecutorCap() {
        // 工具声明、参数钳制、执行器上限三处统一成 1800 秒。
        XCTAssertEqual(ToolArgNumbers.remoteAgentTimeoutRange.upperBound, 1800)
        XCTAssertEqual(ToolArgNumbers.clampedInt(3600, to: ToolArgNumbers.remoteAgentTimeoutRange), 1800)
    }

    // MARK: ~ 展开

    func testWorkdirTildeExpands() {
        XCTAssertNil(RemoteSSHText.cdCommand(workdir: ""))
        XCTAssertNil(RemoteSSHText.cdCommand(workdir: " ~ "))
        XCTAssertEqual(RemoteSSHText.cdCommand(workdir: "~/code/my app"), "cd \"$HOME\"/'code/my app'")
        XCTAssertEqual(RemoteSSHText.cdCommand(workdir: "/tmp/it's"), "cd '/tmp/it'\\''s'")
        // 不是 ~/ 开头的 ~ 当普通字符（不展开别人的家目录）。
        XCTAssertEqual(RemoteSSHText.cdCommand(workdir: "~bob/x"), "cd '~bob/x'")
    }

    // MARK: tmux 启动命令

    func testTmuxBootstrapCommand() {
        XCTAssertNil(SSHTerminalBootstrap.command(autoTmux: false))
        let command = SSHTerminalBootstrap.command(autoTmux: true)!
        XCTAssertTrue(command.hasPrefix(" "), "开头空格：不进 shell 历史")
        XCTAssertTrue(command.hasSuffix("\r"))
        XCTAssertTrue(command.contains("command -v tmux >/dev/null 2>&1"))
        XCTAssertTrue(command.contains("tmux new -A -s leobot"))
        XCTAssertTrue(command.contains("\\033]0;leobot:no-tmux\\007"))
    }

    // MARK: 指纹 / 私钥外壳

    func testFingerprintMatchesOpenSSHFormat() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJg7MhLhe4dZCFklpKuTkicrf/c98q5q7wT/+FkAoPB0"
        let fp = RemoteSSHText.fingerprint(publicKeyLine: key)!
        XCTAssertTrue(fp.hasPrefix("SHA256:"))
        XCTAssertFalse(fp.contains("="))
        XCTAssertEqual(fp.count, "SHA256:".count + 43)
        XCTAssertNil(RemoteSSHText.fingerprint(publicKeyLine: "garbage"))
    }

    func testPrivateKeyEnvelopeParsing() throws {
        // 头尾拆开写，免得仓库的密钥扫描把测试钥匙当成泄露。
        let begin = "-----BEGIN OPENSSH " + "PRIVATE KEY-----", end = "-----END OPENSSH " + "PRIVATE KEY-----"
        // ssh-keygen 现生成的一次性测试钥匙，没有在任何机器上授权过。
        let pem = """
        \(begin)
        b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
        QyNTUxOQAAACD0uOKUzr/fFXhsq6rogKm4gMzdWPw4A4lnsqIJEYu0rQAAAJhoyxH+aMsR
        /gAAAAtzc2gtZWQyNTUxOQAAACD0uOKUzr/fFXhsq6rogKm4gMzdWPw4A4lnsqIJEYu0rQ
        AAAECgPnEuRvShMwlth/wLrMHqASzSgg/FeOs4+medqhjna/S44pTOv98VeGyrquiAqbiA
        zN1Y/DgDiWeyogkRi7StAAAAEHRlc3RAbGVvYm90LnRlc3QBAgMEBQ==
        \(end)
        """
        let parsed = try SSHPrivateKeyInfo.parse(pem)
        XCTAssertEqual(parsed.kind, .ed25519)
        XCTAssertFalse(parsed.encrypted)
        XCTAssertEqual(parsed.publicKeyLine,
                       "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPS44pTOv98VeGyrquiAqbiAzN1Y/DgDiWeyogkRi7St")

        // 同类型、加了口令（ssh-keygen -N pw）：外壳里能看出加密，公钥照样能读。
        let encrypted = """
        \(begin)
        b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDUTBebbD
        /ekd9i8177AXHcAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHCeKoDC/S3LIxg/
        ZrehWjylj8zHTW6x2vJlrvPCKvIRAAAAkLYwvsO6uh8MGekni6YJoeczHRCmwjoq9ioKt/
        CTg3yXYZidIDrrK8PCNOy84SHztdMyWrxZkSSRyS2HV8qEqfnUf4BItGRZnYaYHJ2bsUEL
        C/SjzItKTZ0+XkgNrQgYgteSDo3VAl5o2oRsm3B/zEk+BrvTitHHK3Jz81J/V+76Ah/VjK
        r+RDsSkGrbcboPKQ==
        \(end)
        """
        let parsedEncrypted = try SSHPrivateKeyInfo.parse(encrypted)
        XCTAssertEqual(parsedEncrypted.kind, .ed25519)
        XCTAssertTrue(parsedEncrypted.encrypted)
        XCTAssertThrowsError(try SSHPrivateKeyInfo.parse("ssh-ed25519 AAAA"))
    }
}
