//
//  TTSAudioData.swift
//  MinisApp
//
//  朗读音频的拼接与时长。默认输出格式是 MP3(MiniMax、ElevenLabs 也只给 MP3),
//  以前一律当 44 字节头的 WAV 处理:拆句重试拼接时改坏 MP3 的 ID3 头、每段砍掉 44 字节,
//  时长从偏移 28 读出一堆垃圾,动态分批估算全乱。只有真的是 RIFF/WAVE 才按 WAV 处理。
//

import AVFoundation
import Foundation

enum TTSAudioData {
    static func isWAV(_ data: Data) -> Bool {
        guard data.count >= 12 else { return false }
        return data.prefix(4) == Data("RIFF".utf8) && data.subdata(in: 8..<12) == Data("WAVE".utf8)
    }

    /// 多段拼成一段。全是 WAV:合并 PCM、改写头部大小;否则(MP3 等帧格式)直接首尾相接。
    static func concat(_ pieces: [Data]) -> Data {
        guard let first = pieces.first else { return Data() }
        guard pieces.count > 1 else { return first }
        guard pieces.allSatisfy(isWAV) else { return pieces.reduce(into: Data()) { $0.append($1) } }
        var pcm = Data()
        for w in pieces where w.count > 44 { pcm.append(w.subdata(in: 44..<w.count)) }
        var out = first.subdata(in: 0..<44)
        let dataSize = UInt32(pcm.count).littleEndian
        let riffSize = UInt32(36 + pcm.count).littleEndian
        out.replaceSubrange(4..<8, with: withUnsafeBytes(of: riffSize) { Data($0) })
        out.replaceSubrange(40..<44, with: withUnsafeBytes(of: dataSize) { Data($0) })
        out.append(pcm)
        return out
    }

    /// 时长(秒)。WAV 按头部字节率算;其他格式交给 AVAudioPlayer 解析,解析不了返回 0。
    static func duration(_ data: Data) -> Double {
        if isWAV(data) {
            guard data.count > 44 else { return 0 }
            let byteRate = data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 28, as: UInt32.self) }
            let rate = UInt32(littleEndian: byteRate)
            guard rate > 0 else { return 0 }
            return Double(data.count - 44) / Double(rate)
        }
        return (try? AVAudioPlayer(data: data))?.duration ?? 0
    }
}
