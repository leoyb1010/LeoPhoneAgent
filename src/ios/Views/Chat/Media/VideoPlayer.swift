//
//  VideoPlayer.swift
//  MinisApp
//
//  Inline video thumbnail bubble + fullscreen player overlay +
//  AVPlayerLayer UIViewRepresentable. Extracted from AIChatView.swift.
//

import AVFoundation
import AVKit
import Photos
import SwiftUI
import UIKit

// MARK: - Inline Video Player

// MARK: - Fullscreen Video Player

struct MinisVideoFullscreenPlayer: View {
    let fileURL: URL
    /// Optional externally-managed AVPlayer (e.g. from PlayerOffloadBridge).
    /// When provided, the view skips creating its own player.
    let externalPlayer: AVPlayer?
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var showShareSheet = false
    @State private var saveStatus: SaveStatus = .idle

    init(fileURL: URL, externalPlayer: AVPlayer? = nil) {
        self.fileURL = fileURL
        self.externalPlayer = externalPlayer
    }

    // Custom controls state
    @State private var isPlaying = false
    @State private var currentTime: Double = 0
    @State private var duration: Double = 0
    @State private var showControls = true
    @State private var isScrubbing = false
    @State private var timeObserver: Any?
    @State private var hideTask: DispatchWorkItem?
    @State private var rateObservation: NSKeyValueObservation?

    // Pull-to-dismiss state
    @State private var dragOffset: CGFloat = 0
    private let dismissThreshold: CGFloat = 120

    private enum SaveStatus {
        case idle, saving, saved, failed
    }

    var body: some View {
        ZStack {
            Color.black.opacity(1.0 - Double(max(dragOffset, 0) / dismissThreshold) * 0.4)
                .ignoresSafeArea()
            if let player {
                MinisAVPlayerLayerView(player: player)
                    .ignoresSafeArea()
                    .offset(y: dragOffset)
            }

            // Tap target to toggle controls + drag to dismiss
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { toggleControls() }
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            let ty = value.translation.height
                            // Only allow downward drag (rubber-band for upward)
                            dragOffset = ty > 0 ? ty : ty * 0.3
                        }
                        .onEnded { value in
                            if dragOffset > dismissThreshold * 0.5 {
                                player?.pause()
                                dismiss()
                            } else {
                                withAnimation(.spring(response: 0.3)) {
                                    dragOffset = 0
                                }
                            }
                        }
                )

            // Overlays
            if showControls {
                // Top bar overlay
                VStack {
                    HStack {
                        Button {
                            player?.pause()
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(ChatColors.primaryText)
                                .frame(width: 44, height: 44)
                                .contentShape(Circle())
                                .background(.ultraThinMaterial, in: Circle())
                        }

                        Spacer()

                        Button {
                            saveVideoToPhotos()
                        } label: {
                            Group {
                                switch saveStatus {
                                case .idle:
                                    Image(systemName: "square.and.arrow.down")
                                        .offset(y: -1)
                                case .saving:
                                    ProgressView()
                                        .tint(ChatColors.primaryText)
                                case .saved:
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.green)
                                case .failed:
                                    Image(systemName: "exclamationmark.triangle")
                                }
                            }
                            .font(.body.weight(.semibold))
                            .foregroundStyle(ChatColors.primaryText)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                            .background(.ultraThinMaterial, in: Circle())
                        }
                        .disabled(saveStatus == .saving || saveStatus == .saved)

                        Button {
                            showShareSheet = true
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                                .offset(y: -1)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(ChatColors.primaryText)
                                .frame(width: 44, height: 44)
                                .contentShape(Circle())
                                .background(.ultraThinMaterial, in: Circle())
                        }
                    }
                    .padding(.horizontal)
                    .padding(.top, 7)
                    Spacer()
                }
                .zIndex(10)
                .transition(.opacity)

                // Bottom controls overlay
                VStack {
                    Spacer()
                    HStack(spacing: 16) {
                        // Play / Pause
                        Button {
                            if isPlaying {
                                player?.pause()
                                isPlaying = false
                            } else {
                                // If at end, seek to start
                                if currentTime >= duration - 0.5 && duration > 0 {
                                    player?.seek(to: .zero)
                                    currentTime = 0
                                }
                                player?.play()
                                isPlaying = true
                            }
                            scheduleHide()
                        } label: {
                            Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                .font(.title2)
                                .foregroundStyle(.white)
                                .frame(width: 44, height: 44)
                        }

                        // Current time
                        Text(formatTime(currentTime))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.white.opacity(0.8))

                        // Progress slider
                        Slider(
                            value: $currentTime,
                            in: 0...max(duration, 1),
                            onEditingChanged: { editing in
                                isScrubbing = editing
                                if editing {
                                    hideTask?.cancel()
                                } else {
                                    let target = CMTime(seconds: currentTime, preferredTimescale: 600)
                                    player?.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
                                    scheduleHide()
                                }
                            }
                        )
                        .tint(.white)

                        // Duration
                        Text(formatTime(duration))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.white.opacity(0.8))
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(
                        LinearGradient(
                            colors: [.clear, .black.opacity(0.5)],
                            startPoint: .top, endPoint: .bottom
                        )
                    )
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: showControls)
        .onAppear {
            let p: AVPlayer
            if let externalPlayer {
                p = externalPlayer
            } else {
                p = AVPlayer(url: fileURL)
            }
            player = p
            try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
            try? AVAudioSession.sharedInstance().setActive(true)
            if externalPlayer == nil {
                p.play()
            }
            isPlaying = p.rate > 0

            // Observe duration
            if let item = p.currentItem {
                Task { @MainActor in
                    // Wait for duration to become available
                    let dur = try? await item.asset.load(.duration)
                    if let dur, dur.isNumeric {
                        duration = dur.seconds
                    }
                }
            }

            // Periodic time observer
            let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
            timeObserver = p.addPeriodicTimeObserver(forInterval: interval, queue: .main) { time in
                guard !isScrubbing else { return }
                currentTime = time.seconds
                // Update duration if not yet set
                if duration == 0, let item = p.currentItem, item.duration.isNumeric {
                    duration = item.duration.seconds
                }
                // Detect playback ended
                if let item = p.currentItem, item.duration.isNumeric,
                   time.seconds >= item.duration.seconds - 0.1 {
                    isPlaying = false
                }
            }

            // Observe rate changes (e.g. system pause on background)
            rateObservation = p.observe(\.rate, options: [.new]) { _, change in
                Task { @MainActor in
                    if let newRate = change.newValue {
                        isPlaying = newRate > 0
                    }
                }
            }

            scheduleHide()
        }
        .onDisappear {
            if let observer = timeObserver {
                player?.removeTimeObserver(observer)
                timeObserver = nil
            }
            rateObservation?.invalidate()
            rateObservation = nil
            hideTask?.cancel()
            player?.pause()
            player = nil
        }
        .sheet(isPresented: $showShareSheet) {
            MinisShareSheet(url: fileURL)
        }
        .statusBar(hidden: true)
    }

    private func toggleControls() {
        showControls.toggle()
        if showControls { scheduleHide() }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        let task = DispatchWorkItem { showControls = false }
        hideTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: task)
    }

    private func formatTime(_ seconds: Double) -> String {
        guard seconds.isFinite && seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        let m = total / 60
        let s = total % 60
        return String(format: "%d:%02d", m, s)
    }

    private func saveVideoToPhotos() {
        saveStatus = .saving
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { saveStatus = .failed }
                return
            }
            PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: fileURL)
            } completionHandler: { success, _ in
                DispatchQueue.main.async {
                    saveStatus = success ? .saved : .failed
                    if success {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            saveStatus = .idle
                        }
                    }
                }
            }
        }
    }
}

/// Raw AVPlayerLayer wrapper – renders video with no system controls.
struct MinisAVPlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> UIView {
        let view = PlayerLayerUIView()
        view.backgroundColor = .black
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    class PlayerLayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
