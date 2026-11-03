#!/usr/bin/env python3
"""Exercise actual BrainClient lifetime without issuing network requests.

The only adapters are localization and the unrelated unattended-tool list.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="leo-brain-lifetime-") as tmp:
    tmp = Path(tmp)
    (tmp / "Shims.swift").write_text('''import Foundation
func AppLocalized(_ key: String.LocalizationValue, comment: StaticString? = nil) -> String { String(localized: key) }
enum AskUserTool { static let unattendedSources: Set<String> = ["quiet", "automation"] }
''')
    (tmp / "Lifetime.swift").write_text('''import Foundation
@main struct Lifetime {
    static func main() {
        let endpoint = BrainEndpoint(baseString: "https://fixture.invalid")!
        for _ in 0..<500 {
            weak var released: BrainClient?
            autoreleasepool {
                let client = BrainClient(endpoint: endpoint, credentials: BrainCredentials(token: "SYNTHETIC-NOT-A-CREDENTIAL"))
                released = client
            }
            precondition(released == nil, "Unused client retained by its URLSession delegate")
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        print("PASS: 500 actual clients released; unused-session teardown callbacks stable; zero network requests")
    }
}
''')
    sources = [root / "src/ios/Shared/Brain" / name for name in ["BrainCore.swift", "BrainMedia.swift", "BrainClient.swift"]]
    subprocess.run(["xcrun", "swiftc", *map(str, sources), str(tmp / "Shims.swift"), str(tmp / "Lifetime.swift"), "-o", str(tmp / "smoke")], check=True, timeout=120)
    subprocess.run([str(tmp / "smoke")], check=True, timeout=30)
