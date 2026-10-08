import CommonCrypto
import CryptoKit
import Foundation

/// Passphrase encryption for `.minisbak` (scheme `minisbak-enc/1`), ported
/// unchanged on the wire from upstream so Android packages interoperate.
///
/// KDF: PBKDF2-HMAC-SHA256, 600 000 iterations, 16-byte salt (OWASP floor).
/// Argon2id is not available from any Apple SDK; the format carries
/// `kdf.alg`, so a package declaring `argon2id` is refused loudly rather than
/// guessed at (a silent fallback would surface as "wrong passphrase").
///
/// Subkeys via HKDF: `data` (data/* + blobs/*), `secrets` (secrets.json only),
/// `mac` (manifest), `verify` (instant wrong-passphrase check).
/// Members: `MBK1` then 4 MiB AES-GCM segments, each `UInt32 BE length ‖
/// nonce ‖ ciphertext ‖ tag`, AAD = `"<path>#<segment>"` so a member can be
/// neither renamed nor have segments dropped / reordered undetected.
enum BackupCrypto {

    static let scheme = "minisbak-enc/1"
    static let pbkdf2Iterations = 600_000
    static let saltBytes = 16
    static let segmentSize = 4 * 1024 * 1024
    static let magic = Data([0x4D, 0x42, 0x4B, 0x31])
    /// Minimum passphrase length the UI enforces.
    static let minimumPassphraseLength = 8

    final class Keys: Sendable {
        let dataKey: SymmetricKey
        let secretsKey: SymmetricKey
        let macKey: SymmetricKey
        let verifierKey: SymmetricKey

        fileprivate init(kek: SymmetricKey) {
            func sub(_ info: String) -> SymmetricKey {
                SymmetricKey(data: HKDF<SHA256>.deriveKey(
                    inputKeyMaterial: kek, info: Data(info.utf8), outputByteCount: 32))
            }
            dataKey = sub("minisbak/data")
            secretsKey = sub("minisbak/secrets")
            macKey = sub("minisbak/mac")
            verifierKey = sub("minisbak/verify")
        }

        /// `HMAC(verifier_key, "minisbak-v1")[0..<16]`, base64.
        var verifier: String {
            var mac = HMAC<SHA256>(key: verifierKey)
            mac.update(data: Data("minisbak-v1".utf8))
            return Data(mac.finalize().prefix(16)).base64EncodedString()
        }
    }

    enum CryptoError: LocalizedError, Equatable {
        case unsupportedKDF(String)
        case unsupportedScheme(String)
        case wrongPassphrase
        case corruptMember(String)
        case manifestTampered

        var errorDescription: String? {
            switch self {
            case .unsupportedKDF(let a): return String(localized: "备份使用了不支持的密钥派生算法（\(a)），请更新 LeoBot")
            case .unsupportedScheme(let s): return String(localized: "备份使用了不支持的加密方案（\(s)），请更新 LeoBot")
            case .wrongPassphrase: return String(localized: "密码不正确")
            case .corruptMember: return String(localized: "加密内容已损坏或被篡改")
            case .manifestTampered: return String(localized: "备份清单校验失败，文件可能被修改过")
            }
        }
    }

    // MARK: - Derivation

    static func makeSalt() -> Data {
        var bytes = [UInt8](repeating: 0, count: saltBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, saltBytes, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes)
    }

    static func deriveKeys(passphrase: String, kdf: BackupManifest.Encryption.KDF) throws -> Keys {
        guard let salt = Data(base64Encoded: kdf.salt), !salt.isEmpty else {
            throw CryptoError.corruptMember("manifest.encryption.kdf.salt")
        }
        switch kdf.alg {
        case "pbkdf2-hmac-sha256":
            let iterations = kdf.iterations ?? pbkdf2Iterations
            // A hostile manifest must not be able to make us spin for hours.
            guard (1_000...2_000_000).contains(iterations) else { throw CryptoError.unsupportedKDF(kdf.alg) }
            return Keys(kek: try pbkdf2(passphrase: passphrase, salt: salt, iterations: iterations))
        default:
            throw CryptoError.unsupportedKDF(kdf.alg)
        }
    }

    static func currentKDF(salt: Data) -> BackupManifest.Encryption.KDF {
        .init(alg: "pbkdf2-hmac-sha256", mKib: nil, t: nil, p: nil,
              iterations: pbkdf2Iterations, salt: salt.base64EncodedString())
    }

    private static func pbkdf2(passphrase: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        var out = [UInt8](repeating: 0, count: 32)
        let pwBytes = Array(passphrase.utf8)
        let status: Int32 = salt.withUnsafeBytes { saltPtr in
            pwBytes.withUnsafeBufferPointer { pwPtr in
                // Explicit length: an embedded NUL cannot truncate the passphrase.
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    pwPtr.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) },
                    pwBytes.count,
                    saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &out, out.count)
            }
        }
        guard status == kCCSuccess else { throw CryptoError.corruptMember("kdf") }
        let key = SymmetricKey(data: Data(out))
        _ = out.withUnsafeMutableBytes { memset_s($0.baseAddress, $0.count, 0, $0.count) }
        return key
    }

    // MARK: - Member encryption

    static func encryptFile(at source: URL, to destination: URL, key: SymmetricKey, path: String) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        try output.write(contentsOf: magic)
        var index = 0
        while true {
            let done = try autoreleasepool { () -> Bool in
                let chunk = try input.read(upToCount: segmentSize) ?? Data()
                if chunk.isEmpty { return true }
                let sealed = try AES.GCM.seal(chunk, using: key, authenticating: aad(path: path, segment: index))
                guard let combined = sealed.combined else { throw CryptoError.corruptMember(path) }
                var length = UInt32(combined.count).bigEndian
                try output.write(contentsOf: Data(bytes: &length, count: 4))
                try output.write(contentsOf: combined)
                index += 1
                return false
            }
            if done { break }
        }
    }

    static func decryptFile(at source: URL, to destination: URL, key: SymmetricKey, path: String) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard let header = try input.read(upToCount: magic.count), header == magic else {
            throw CryptoError.corruptMember(path)
        }
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        // nonce (12) + one full segment + tag (16)
        let maxSegment = segmentSize + 12 + 16
        var index = 0
        while true {
            let done = try autoreleasepool { () -> Bool in
                guard let lenData = try input.read(upToCount: 4), !lenData.isEmpty else { return true }
                guard lenData.count == 4 else { throw CryptoError.corruptMember(path) }
                let length = Int(lenData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian })
                guard length > 28, length <= maxSegment,
                      let body = try input.read(upToCount: length), body.count == length else {
                    throw CryptoError.corruptMember(path)
                }
                do {
                    let box = try AES.GCM.SealedBox(combined: body)
                    let plain = try AES.GCM.open(box, using: key, authenticating: aad(path: path, segment: index))
                    try output.write(contentsOf: plain)
                } catch {
                    throw CryptoError.corruptMember(path)
                }
                index += 1
                return false
            }
            if done { break }
        }
    }

    private static func aad(path: String, segment: Int) -> Data {
        Data("\(path)#\(segment)".utf8)
    }

    // MARK: - Manifest authentication

    /// HMAC over the canonical re-encoding of the manifest without its MAC
    /// (embedded `manifest_mac`, upstream-compatible).
    static func manifestMAC(_ manifest: BackupManifest, key: SymmetricKey) throws -> String {
        var copy = manifest
        copy.manifestMac = nil
        let data = try BackupDates.encoder().encode(copy)
        var mac = HMAC<SHA256>(key: key)
        mac.update(data: data)
        return Data(mac.finalize()).base64EncodedString()
    }

    /// HMAC over the RAW bytes of manifest.json (sidecar `manifest.mac`);
    /// immune to decode/re-encode drift across versions. Preferred on read.
    static func manifestMAC(rawBytes: Data, key: SymmetricKey) -> String {
        var mac = HMAC<SHA256>(key: key)
        mac.update(data: rawBytes)
        return Data(mac.finalize()).base64EncodedString()
    }

    static func verifyManifestMAC(rawBytes: Data, expected: String, key: SymmetricKey) throws {
        guard constantTimeEqual(manifestMAC(rawBytes: rawBytes, key: key), expected) else {
            throw CryptoError.manifestTampered
        }
    }

    static func verifyManifestMAC(_ manifest: BackupManifest, key: SymmetricKey) throws {
        guard let expected = manifest.manifestMac else { throw CryptoError.manifestTampered }
        guard constantTimeEqual(try manifestMAC(manifest, key: key), expected) else {
            throw CryptoError.manifestTampered
        }
    }

    static func verifierMatches(_ stored: String, keys: Keys) -> Bool {
        constantTimeEqual(stored, keys.verifier)
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        guard let a = Data(base64Encoded: lhs), let b = Data(base64Encoded: rhs),
              a.count == b.count, !a.isEmpty else { return false }
        return a.withUnsafeBytes { ap in
            b.withUnsafeBytes { bp in timingsafe_bcmp(ap.baseAddress!, bp.baseAddress!, a.count) == 0 }
        }
    }
}
