import XCTest

/// Upstream voice reliability fixes ported onto our H1–H7 voice stack.
final class VoiceReliabilityPortTests: XCTestCase {
    func testAzureAndXunfeiSpeakWithTheSelectedEntryVoice() {
        XCTAssertEqual(TTSVoiceSelection.azure(voice: nil, model: "zh-CN-YunxiNeural"), "zh-CN-YunxiNeural",
                       "the entry passed as model is the voice; it must not fall back to the default")
        XCTAssertEqual(TTSVoiceSelection.azure(voice: "en-US-GuyNeural", model: "zh-CN-YunxiNeural"), "en-US-GuyNeural")
        XCTAssertNil(TTSVoiceSelection.azure(voice: "", model: nil))
        XCTAssertEqual(TTSVoiceSelection.xunfei(voice: nil, model: "aisjiuxu", fallback: "xiaoyan"), "aisjiuxu")
        XCTAssertEqual(TTSVoiceSelection.xunfei(voice: nil, model: "iat", fallback: "xiaoyan"), "xiaoyan",
                       "the ASR entry is never a voice")
        XCTAssertEqual(TTSVoiceSelection.xunfei(voice: "x2", model: "aisjiuxu", fallback: "xiaoyan"), "x2")
    }

    func testCapsuleRisesImmediatelyButDescendsOnlyAfterSettling() {
        typealias R = CapsuleLiftRatchet
        XCTAssertEqual(R.decide(newLift: 120, currentLift: 40, allowDescent: false, descentPending: true), .rise)
        XCTAssertEqual(R.decide(newLift: 40, currentLift: 120, allowDescent: false, descentPending: false), .armDescent)
        XCTAssertEqual(R.decide(newLift: 40, currentLift: 120, allowDescent: false, descentPending: true), .waitPending)
        XCTAssertEqual(R.decide(newLift: 40, currentLift: 120, allowDescent: true, descentPending: false), .descend)
        XCTAssertEqual(R.decide(newLift: 118, currentLift: 120, allowDescent: false, descentPending: true), .cancelPending,
                       "an obstacle that came back cancels the pending descent")
        XCTAssertEqual(R.decide(newLift: 118, currentLift: 120, allowDescent: false, descentPending: false), .none)
    }
}
