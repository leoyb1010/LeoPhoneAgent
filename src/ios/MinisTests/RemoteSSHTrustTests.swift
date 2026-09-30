import Foundation
import XCTest

final class RemoteSSHTrustTests: XCTestCase {
    private let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJg7MhLhe4dZCFklpKuTkicrf/c98q5q7wT/+FkAoPB0"

    func testDirectSetupRequiresEd25519WhileGatewayKeepsOtherPins() {
        XCTAssertEqual(RemoteSSHTrust.directPublicKey(key + " trusted console"), key)
        for algorithm in ["ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"] {
            let pin = algorithm + " AQID"
            XCTAssertNil(RemoteSSHTrust.directPublicKey(pin))
            XCTAssertEqual(RemoteSSHTrust.normalizedPublicKey(pin), pin)
            XCTAssertNotNil(RemoteSSHTrust.relayCommand(host: "example.com", port: 22,
                username: "leo", publicKey: pin, command: "pwd"))
        }
        XCTAssertNil(RemoteSSHTrust.directPublicKey("ssh-ed25519 ???"))
    }

    func testTrustRequiresExactEndpointAndExplicitKey() {
        let endpoint = RemoteSSHTrust.endpoint(host: " Example.COM ", port: 22)
        XCTAssertEqual(endpoint, "[example.com]:22")
        XCTAssertEqual(RemoteSSHTrust.pinnedKey(host: "example.com", port: 22, key: key, trustedEndpoint: endpoint), key)
        XCTAssertNil(RemoteSSHTrust.pinnedKey(host: "example.com", port: 2222, key: key, trustedEndpoint: endpoint))
        XCTAssertNil(RemoteSSHTrust.pinnedKey(host: "other.example", port: 22, key: key, trustedEndpoint: endpoint))
        XCTAssertNil(RemoteSSHTrust.pinnedKey(host: "example.com", port: 22, key: key, trustedEndpoint: nil))
        XCTAssertNil(RemoteSSHTrust.pinnedKey(host: "example.com", port: 22, key: nil, trustedEndpoint: endpoint))
        XCTAssertNil(RemoteSSHTrust.pinnedKey(host: "example.com", port: 0, key: key, trustedEndpoint: "[example.com]:0"))
    }

    func testOnlySinglePublicKeyLinesAreAccepted() {
        XCTAssertEqual(RemoteSSHTrust.normalizedPublicKey(key + " trusted console"), key)
        for invalid in ["", "-----BEGIN OPENSSH PRIVATE KEY-----", "ssh-ed25519 ???", key + "\n" + key, "ssh-ed25519 "] {
            XCTAssertNil(RemoteSSHTrust.normalizedPublicKey(invalid))
        }
    }

    func testGatewayUsesOnlyPinnedHostKeyAndQuotesInputs() {
        let command = RemoteSSHTrust.relayCommand(host: "example.com", port: 2222, username: "leo", publicKey: key, command: "printf '%s' ok")!
        XCTAssertTrue(command.contains("StrictHostKeyChecking=yes"))
        XCTAssertFalse(command.contains("accept-new"))
        XCTAssertTrue(command.contains("GlobalKnownHostsFile=/dev/null"))
        XCTAssertTrue(command.contains("leo-pinned-target " + key))
        XCTAssertTrue(command.contains("-l 'leo' -- 'example.com'"))
        XCTAssertTrue(command.contains("'printf '\\''%s'\\'' ok'"))
        XCTAssertNil(RemoteSSHTrust.relayCommand(host: "-oProxyCommand=bad", port: 22, username: "leo", publicKey: key, command: "pwd"))
        XCTAssertNil(RemoteSSHTrust.relayCommand(host: "host\nother", port: 22, username: "leo", publicKey: key, command: "pwd"))
    }
}
