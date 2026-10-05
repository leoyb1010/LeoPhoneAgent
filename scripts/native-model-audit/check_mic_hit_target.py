#!/usr/bin/env python3
"""Compile the unchanged production mic hit-test function on the macOS host.
No simulator, device, microphone, provider or credentials are accessed.
"""
import argparse
import re
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("source", nargs="?", type=Path,
                    default=Path(__file__).resolve().parents[2] / "src/ios/Views/Chat/AIChatView.swift")
args = parser.parse_args()
source = args.source.read_text()
mic = source[source.index("private struct MicButton: View {"):]
mic = mic[:mic.index("// MARK: - Compact Summary Sheet")]
constants = re.findall(r"private static let (?:hitDiameter|diameter): CGFloat = \d+", mic)
start = mic.index("private static func isInside(")
brace = mic.index("{", start)
depth, end = 1, brace + 1
while depth:
    if mic[end] == "{":
        depth += 1
    elif mic[end] == "}":
        depth -= 1
    end += 1
function = mic[start:end]
checks = '''
    static func main() {
        func check(_ value: Bool) { if !value { print("FAIL: production mic touch circle does not match 44-point contract"); exit(1) } }
        check(isInside(CGPoint(x: 22, y: 22)))
        check(isInside(CGPoint(x: 0, y: 22)))
        check(isInside(CGPoint(x: 44, y: 22)))
        check(isInside(CGPoint(x: 40, y: 22)))
        check(!isInside(CGPoint(x: -0.1, y: 22)))
        check(!isInside(CGPoint(x: 44.1, y: 22)))
        check(!isInside(CGPoint(x: 0, y: 0)))
        print("Production MicButton geometry: 44-point boundary and drag exclusion passed")
    }
'''
with tempfile.TemporaryDirectory(prefix="leophone-mic-hit-") as tmp:
    temp = Path(tmp)
    host = temp / "MicHitTarget.swift"
    host.write_text("import Foundation\n@main enum MicHitTarget {\n" +
                    "\n".join(constants) + "\n" + function + checks + "\n}\n")
    subprocess.run(["swiftc", "-parse-as-library", str(host), "-o", str(temp / "check")], check=True)
    subprocess.run([str(temp / "check")], check=True)
