#!/usr/bin/env python3
"""Exercise the real VAD notification handlers without activating any microphone."""
from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[1]
source = (root / 'src/ios/Providers/Voice/VoiceActivityDetector.swift').read_text()
start = source.index('    @objc private func handleInterruption(')
end = source.index('    /// Rebuild the engine/tap/VAD', start)
handlers = source[start:end].replace('@objc private func', 'func')
stop_start = source.index('    private func fullStopFromInterruption()')
stop_end = source.index('    func stop()', stop_start)
stop_handler = source[stop_start:stop_end]
swift = r'''
import Foundation
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
let AVAudioSessionInterruptionTypeKey = "type"
let AVAudioSessionInterruptionOptionKey = "options"
enum AVAudioSession {
 enum InterruptionType: UInt { case began = 1, ended = 0 }
 struct InterruptionOptions: OptionSet { let rawValue: UInt; static let shouldResume = Self(rawValue: 1) }
}
enum VoiceLog { static func log(_ text: String) {} }
enum SegmentEndReason { case manualFlush }
final class FakeDelegate { func voiceActivityInterrupted() {} }
final class FakeEngine { var isRunning = false }
final class Harness {
 var isRunning = true
 var interruptedWhileRunning = false
 var resumes = 0, stops = 0
 var trace: [String] = []
 let delegate: FakeDelegate? = FakeDelegate()
 let audioEngine = FakeEngine()
 func tearDownEngineOnly() { audioEngine.isRunning = false }
 func attemptResume() { resumes += 1 }
 func flushCapturedSegment(reason: SegmentEndReason) { trace.append("flush") }
 func tearDown() { trace.append("stop"); stops += 1; isRunning = false }
''' + handlers + stop_handler + r'''
}
func note(_ type: UInt, _ options: UInt = 0) -> Notification {
 Notification(name: Notification.Name("fixture"), userInfo: ["type": type, "options": options])
}
let noResume = Harness()
noResume.handleInterruption(note(1))
noResume.handleInterruption(note(0))
guard noResume.resumes == 0 && noResume.stops == 1 else { fail("System denied automatic resume, but microphone restart was attempted") }
guard noResume.trace == ["flush", "stop"] else { fail("Buffered speech was discarded before stop") }
let activeCall = Harness()
activeCall.handleInterruption(note(1))
activeCall.handleRouteChange(note(0))
guard activeCall.resumes == 0 else { fail("Route change resumed capture before interruption ended") }
activeCall.handleInterruption(note(0, 1))
guard activeCall.resumes == 1 else { fail("Authorized interruption recovery was lost") }
let stopped = Harness(); stopped.isRunning = false
stopped.handleRouteChange(note(0))
guard stopped.resumes == 0 else { fail("Stopped capture resumed on route change") }
let route = Harness(); route.handleRouteChange(note(0))
guard route.resumes == 1 else { fail("Active capture cannot recover its route") }
let background = Harness()
let queued = DispatchSemaphore(value: 0)
DispatchQueue.global().async { background.handleRouteChange(note(0)); queued.signal() }
guard queued.wait(timeout: .now() + 2) == .success else { fail("Route callback stalled") }
guard background.resumes == 0 else { fail("Route callback touched capture engine on background thread") }
RunLoop.main.run(until: Date().addingTimeInterval(0.05))
guard background.resumes == 1 else { fail("Route recovery did not reach main thread") }
print("PASS actual VAD handlers: system resume hint, in-progress interruption, explicit stop, route recovery")
'''
with tempfile.TemporaryDirectory(prefix='leophone-interruption-') as folder:
    code = Path(folder) / 'main.swift'; code.write_text(swift)
    binary = Path(folder) / 'smoke'
    subprocess.run(['swiftc', str(code), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
