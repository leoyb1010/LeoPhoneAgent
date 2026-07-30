//
//  WatchVoiceRecorder.swift
//  LeoWatch
//
//  [T-watch-native-voice] The product's own voice path on the wrist: tap →
//  record immediately in OUR UI (live metering drives the bars), tap → stop
//  and ship the audio to the iPhone, whose existing speech stack transcribes
//  and runs the agent. No system input modal anywhere.
//

import AVFoundation
import Foundation
import WatchKit

@MainActor
final class WatchVoiceRecorder: NSObject, ObservableObject {
    static let shared = WatchVoiceRecorder()

    @Published private(set) var isRecording = false
    /// 0…1 smoothed input level for the live bars.
    @Published private(set) var level: Double = 0
    @Published private(set) var permissionDenied = false

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var autoStopTask: Task<Void, Never>?
    private var fileURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("leo-ask.m4a")
    }

    /// Max utterance — keeps the payload well inside WCSession message limits.
    private let maxSeconds: TimeInterval = 30

    func start() async -> Bool {
        let granted = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { ok in
                continuation.resume(returning: ok)
            }
        }
        guard granted else {
            permissionDenied = true
            return false
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            try? FileManager.default.removeItem(at: fileURL)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
            recorder.isMeteringEnabled = true
            recorder.record()
            self.recorder = recorder
            isRecording = true
            WKInterfaceDevice.current().play(.start)
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tickMeter() }
            }
            autoStopTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64((self?.maxSeconds ?? 30) * 1_000_000_000))
                if let self, self.isRecording { _ = self.stop() }
            }
            return true
        } catch {
            isRecording = false
            return false
        }
    }

    /// Stops and returns the recorded audio (nil when nothing usable).
    @discardableResult
    func stop() -> Data? {
        meterTimer?.invalidate(); meterTimer = nil
        autoStopTask?.cancel(); autoStopTask = nil
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        // Sub-half-second taps are almost certainly accidental.
        guard duration > 0.5, let data = try? Data(contentsOf: fileURL), data.count > 1000 else {
            return nil
        }
        return data
    }

    private func tickMeter() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let db = recorder.averagePower(forChannel: 0)   // ~ -60…0
        let normalized = max(0, min(1, Double(db + 50) / 50))
        // Light smoothing so the bars feel organic, not jittery.
        level = level * 0.6 + normalized * 0.4
    }
}
