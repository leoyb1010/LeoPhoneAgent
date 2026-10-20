//
//  ScreenPeerClient.swift
//  MinisApp
//
//  [WP-51 R1] 看 Mac 屏幕的 WebRTC 视频;[WP-52 R2] 同一条连接上的 `leo-input` 操控通道。
//
//  - 信令(预检 / offer / answer / ice / 状态 / 关闭)走 LeoAgentClient:直连优先、中继兜底,
//    和 R0 截图同一套路由。视频本身点对点(SRTP),不过中继。
//  - 手机是 offerer:只收视频(recvonly,H.264 放第一),要操控时在 offer 前建 `leo-input`。
//  - 连不上 / 被拒 → 状态变 failed,界面回退 R0 截图(ScreenViewModePolicy)。
//  - 退到后台就 DELETE 关掉(画中画开着的时候除外)。
//  - libwebrtc 的 Swift 接口不暴露 jitterBufferTarget,接收端缓冲用默认值(偏差，见汇报)。
//

import AVFoundation
import AVKit
import Foundation
import UIKit
import WebRTC

private let screenLog = AppLogger(category: "ScreenPeer")

extension LeoAgentClient {
    private func screenSessionRequest(_ path: String, method: String = "GET", body: Data? = nil)
        async -> (status: Int, data: Data, error: MacScreenError?) {
        do {
            var req = try request(path, method: method, body: body, service: .harness)
            req.timeoutInterval = 15
            if body == nil { req.setValue(nil, forHTTPHeaderField: "Content-Type") }
            let (data, response) = try await routedData(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) { return (status, data, nil) }
            return (status, data, MacScreenSnapshotWire.error(status: status, data: data))
        } catch GatewayError.harnessNotConfigured {
            return (0, Data(), MacScreenError(status: 0, code: "not_supported"))
        } catch {
            return (0, Data(), MacScreenError(status: 0, code: "offline", message: error.localizedDescription))
        }
    }

    func screenPreflight() async -> Result<ScreenSessionPreflight, MacScreenError> {
        let r = await screenSessionRequest(ScreenSessionWire.path)
        if let error = r.error { return .failure(error) }
        guard let parsed = ScreenSessionWire.parsePreflight(r.data) else {
            return .failure(MacScreenError(status: r.status, code: "malformed"))
        }
        return .success(parsed)
    }

    func openScreenSession(_ body: Data) async -> Result<ScreenSessionOpened, MacScreenError> {
        let r = await screenSessionRequest(ScreenSessionWire.path, method: "POST", body: body)
        if let error = r.error { return .failure(error) }
        guard let parsed = ScreenSessionWire.parseOpened(r.data) else {
            return .failure(MacScreenError(status: r.status, code: "malformed"))
        }
        return .success(parsed)
    }

    func trickleScreenCandidates(sessionId: String, body: Data) async {
        _ = await screenSessionRequest("\(ScreenSessionWire.path)/\(sessionId)/ice", method: "POST", body: body)
    }

    func screenSessionStats(sessionId: String) async -> ScreenSessionStats? {
        let r = await screenSessionRequest("\(ScreenSessionWire.path)/\(sessionId)")
        return r.error == nil ? ScreenSessionWire.parseStats(r.data) : nil
    }

    func closeScreenSession(sessionId: String) async {
        _ = await screenSessionRequest("\(ScreenSessionWire.path)/\(sessionId)", method: "DELETE")
    }
}

/// One libwebrtc factory per process (SSL init once).
private enum ScreenRTC {
    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                        decoderFactory: RTCDefaultVideoDecoderFactory())
    }()
}

@MainActor
final class ScreenPeerClient: ObservableObject {
    enum State: Equatable {
        case idle
        case connecting
        case connected
        case failed(MacScreenError)
        case closed
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var videoTrack: RTCVideoTrack?
    /// Mac 给了操控通道(会话 control: true 且通道已打开)。
    @Published private(set) var controlReady = false
    /// 要了操控、Mac 没给:显示怎么去开。
    @Published private(set) var controlRefused = false
    @Published private(set) var inputStatus: ScreenInputStatus?
    @Published private(set) var stats: ScreenSessionStats?
    @Published private(set) var videoSize: CGSize = .zero

    let client: LeoAgentClient
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var sessionId: String?
    private var pendingCandidates: [ScreenSessionWire.Candidate] = []
    private var trickleTask: Task<Void, Never>?
    private var statsTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    /// PeerBridge 用它认出自己是不是当前这条连接的(旧连接迟到的回调直接丢)。
    fileprivate private(set) var bridge: PeerBridge?
    private var wantsControl = false
    private var attempt = MacScreenAttempt()

    init(client: LeoAgentClient) {
        self.client = client
    }

    var isActive: Bool { state == .connecting || state == .connected }

    func start(control: Bool) {
        guard !isActive else { return }
        wantsControl = control
        controlRefused = false
        controlReady = false
        inputStatus = nil
        state = .connecting
        let id = attempt.begin()
        Task { await connect(id) }
    }

    func stop() {
        let id = sessionId
        teardown()
        state = .closed
        if let id {
            let client = self.client
            Task { await client.closeScreenSession(sessionId: id) }
        }
    }

    /// 发一个输入事件(只有 Mac 给了操控时才发)。
    func send(_ event: ScreenInputEvent) {
        guard controlReady, let channel, channel.readyState == .open else { return }
        channel.sendData(RTCDataBuffer(data: Data(event.message.utf8), isBinary: false))
    }

    func sendText(_ text: String) {
        for event in ScreenInputEvent.textEvents(text) { send(event) }
    }

    // MARK: Connect

    /// 这一次连接已经过期(stop / fail / 重新 start 过):关掉它自己建的本地 peer,别再碰共享状态。
    private func isStale(_ id: Int, closing peer: RTCPeerConnection?) -> Bool {
        guard !attempt.isCurrent(id) else { return false }
        peer?.close()
        return true
    }

    private func connect(_ id: Int) async {
        // 预检失败直接用这次的错误,不为取错误再请求一次。
        let preflight: ScreenSessionPreflight
        switch await client.screenPreflight() {
        case .success(let value): preflight = value
        case .failure(let error):
            if isStale(id, closing: nil) { return }
            return fail(error)
        }
        // 预检期间被 stop 了:不能再建 peer(否则 stop 之后又冒出一条连接)。
        if isStale(id, closing: nil) { return }
        let config = RTCConfiguration()
        config.iceServers = preflight.iceServers.map {
            RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential)
        }
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.continualGatheringPolicy = .gatherContinually
        let bridge = PeerBridge(owner: self)
        self.bridge = bridge
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = ScreenRTC.factory.peerConnection(with: config, constraints: constraints, delegate: bridge) else {
            return fail(MacScreenError(status: 0, code: "negotiation_failed"))
        }
        self.peer = peer
        let initParams = RTCRtpTransceiverInit()
        initParams.direction = .recvOnly
        if let transceiver = peer.addTransceiver(of: .video, init: initParams) {
            let codecs = ScreenRTC.factory.rtpReceiverCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs
            let h264 = codecs.filter { $0.name.uppercased() == "H264" }
            let rest = codecs.filter { $0.name.uppercased() != "H264" }
            // ObjC `setCodecPreferences:error:` collides with the deprecated overload, so Swift keeps
            // an `error: ()` label on the throwing import.
            do {
                try transceiver.setCodecPreferences(h264 + rest, error: ())
            } catch {
                // 不致命(按默认顺序协商),但 H.264 没排到第一时画质/功耗会差,记下来好查。
                screenLog.warning("setCodecPreferences failed: \(error.localizedDescription)")
            }
            if let track = transceiver.receiver.track as? RTCVideoTrack { videoTrack = track }
        }
        if wantsControl {
            let channelConfig = RTCDataChannelConfiguration()
            channelConfig.isOrdered = true
            channel = peer.dataChannel(forLabel: ScreenSessionWire.inputLabel, configuration: channelConfig)
            channel?.delegate = bridge
        }
        let offer: RTCSessionDescription
        do {
            offer = try await withCheckedThrowingContinuation { continuation in
                peer.offer(for: constraints) { sdp, error in
                    if let sdp { continuation.resume(returning: sdp) }
                    else { continuation.resume(throwing: error ?? URLError(.unknown)) }
                }
            }
            if isStale(id, closing: peer) { return }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                peer.setLocalDescription(offer) { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        } catch {
            if isStale(id, closing: peer) { return }
            return fail(MacScreenError(status: 0, code: "negotiation_failed", message: error.localizedDescription))
        }
        if isStale(id, closing: peer) { return }
        let opened: ScreenSessionOpened
        let openResult = await client.openScreenSession(ScreenSessionWire.openBody(offer: offer.sdp, control: wantsControl))
        if isStale(id, closing: peer) {
            // Mac 已经开了会话,这边却不要了:关掉,免得占着「只有一个观看者」的名额。
            if case .success(let late) = openResult {
                let client = self.client
                Task { await client.closeScreenSession(sessionId: late.sessionId) }
            }
            return
        }
        switch openResult {
        case .success(let value): opened = value
        case .failure(let error): return fail(error)
        }
        sessionId = opened.sessionId
        controlRefused = wantsControl && !opened.control
        do {
            let answer = RTCSessionDescription(type: .answer, sdp: opened.answer)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                peer.setRemoteDescription(answer) { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        } catch {
            if isStale(id, closing: peer) { return }
            return fail(MacScreenError(status: 0, code: "negotiation_failed", message: error.localizedDescription))
        }
        // 走到这里前 stop() 过:它已经按 sessionId 发了 DELETE,这里只关本地 peer。
        if isStale(id, closing: peer) { return }
        flushCandidates()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ScreenViewModePolicy.connectTimeout))
            guard let self, !Task.isCancelled, self.state == .connecting else { return }
            self.fail(MacScreenError(status: 0, code: "connect_timeout"))
        }
    }

    private func fail(_ error: MacScreenError) {
        let id = sessionId
        teardown()
        state = .failed(error)
        if let id {
            let client = self.client
            Task { await client.closeScreenSession(sessionId: id) }
        }
    }

    private func teardown() {
        attempt.invalidate()
        timeoutTask?.cancel(); timeoutTask = nil
        trickleTask?.cancel(); trickleTask = nil
        statsTask?.cancel(); statsTask = nil
        channel?.close(); channel = nil
        peer?.close(); peer = nil
        bridge = nil
        sessionId = nil
        pendingCandidates = []
        videoTrack = nil
        controlReady = false
        stats = nil
    }

    // MARK: Events from the bridge (main actor)

    fileprivate func gathered(_ candidate: RTCIceCandidate) {
        pendingCandidates.append(.init(candidate: candidate.sdp, sdpMid: candidate.sdpMid,
                                       sdpMLineIndex: candidate.sdpMLineIndex))
        // Batch a burst of candidates into one call.
        guard trickleTask == nil else { return }
        trickleTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            // teardown 取消了这次合并:不能把新一轮的 trickleTask 清掉,也不把旧候选发出去。
            guard !Task.isCancelled, let self else { return }
            self.trickleTask = nil
            self.flushCandidates()
        }
    }

    private func flushCandidates() {
        guard let sessionId, !pendingCandidates.isEmpty else { return }
        let bodies = ScreenSessionWire.iceBodies(pendingCandidates)
        pendingCandidates = []
        let client = self.client
        Task { for body in bodies { await client.trickleScreenCandidates(sessionId: sessionId, body: body) } }
    }

    fileprivate func connectionChanged(_ newState: RTCPeerConnectionState) {
        switch newState {
        case .connected:
            timeoutTask?.cancel(); timeoutTask = nil
            state = .connected
            startStats()
        case .failed:
            fail(MacScreenError(status: 0, code: "ice_failed"))
        case .closed:
            if isActive { state = .closed }
        default:
            break
        }
    }

    fileprivate func receiverAdded(_ track: RTCVideoTrack) {
        if videoTrack == nil { videoTrack = track }
    }

    fileprivate func channelChanged(_ channel: RTCDataChannel) {
        controlReady = channel.readyState == .open && !controlRefused
    }

    fileprivate func channelMessage(_ text: String) {
        if let status = ScreenInputStatus.parse(text) { inputStatus = status }
    }

    func frameSizeChanged(_ size: CGSize) {
        if size != videoSize { videoSize = size }
    }

    private func startStats() {
        statsTask?.cancel()
        statsTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let id = self.sessionId else { return }
                if let value = await self.client.screenSessionStats(sessionId: id) { self.stats = value }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }
}

/// libwebrtc calls back on its signalling thread; everything hops to the main actor.
private final class PeerBridge: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    weak var owner: ScreenPeerClient?

    init(owner: ScreenPeerClient) { self.owner = owner }

    private func onMain(_ work: @escaping @MainActor (ScreenPeerClient) -> Void) {
        Task { @MainActor [weak self] in
            guard let self, let owner = self.owner, owner.bridge === self else { return }
            work(owner)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.videoTracks.first { onMain { $0.receiverAdded(track) } }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onMain { $0.gathered(candidate) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        onMain { $0.connectionChanged(newState) }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        if let track = rtpReceiver.track as? RTCVideoTrack { onMain { $0.receiverAdded(track) } }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        onMain { $0.channelChanged(dataChannel) }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else { return }
        onMain { $0.channelMessage(text) }
    }
}

// MARK: - Rendering + picture in picture

/// RTCMTLVideoView renders on screen; this renderer also feeds an AVSampleBufferDisplayLayer so the
/// stream can continue in picture in picture (AVPictureInPictureController's sample-buffer source).
final class ScreenPiPRenderer: NSObject, RTCVideoRenderer, @unchecked Sendable {
    let displayLayer = AVSampleBufferDisplayLayer()
    var onSize: ((CGSize) -> Void)?

    override init() {
        super.init()
        displayLayer.videoGravity = .resizeAspect
    }

    func setSize(_ size: CGSize) {
        let handler = onSize
        DispatchQueue.main.async { handler?(size) }
    }

    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame, let buffer = frame.buffer as? RTCCVPixelBuffer else { return }
        let pixelBuffer = buffer.pixelBuffer
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                     formatDescriptionOut: &format)
        guard let format else { return }
        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: CMTime(value: frame.timeStampNs, timescale: 1_000_000_000),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                 formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        let layer = displayLayer
        // iOS 27 deprecates these in favour of AVSampleBufferRenderSynchronizer receivers; they still work,
        // and a live stream needs no synchronizer clock. Revisit with the R1 device pass.
        DispatchQueue.main.async {
            if layer.sampleBufferRenderer.status == .failed { layer.sampleBufferRenderer.flush() }
            layer.sampleBufferRenderer.enqueue(sample)
        }
    }
}

/// 画中画:直播内容，没有时间轴。
final class ScreenPiPController: NSObject, AVPictureInPictureSampleBufferPlaybackDelegate, AVPictureInPictureControllerDelegate {
    let renderer = ScreenPiPRenderer()
    private(set) var controller: AVPictureInPictureController?
    var onActiveChange: ((Bool) -> Void)?
    /// 画中画正在起或已经起来(willStart 就置上,比 didStart 早):退到后台的那一下据此别拆视频。
    private(set) var isEngaged = false
    /// 当前视频轨道。PiP 渲染器每帧都要转一次 CMSampleBuffer,只在画中画时挂上去,平时不白耗 CPU。
    private weak var track: RTCVideoTrack?
    private var feeding = false
    /// 开画中画前的音频会话设置,结束时还原(不然别的 App 的音频行为一直被改成 playback)。
    private var savedAudio: (category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                             options: AVAudioSession.CategoryOptions)?

    static var isSupported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    /// The display layer must be in a view hierarchy for PiP to start.
    func attach() {
        guard controller == nil, Self.isSupported else { return }
        let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: renderer.displayLayer,
                                                                playbackDelegate: self)
        let pip = AVPictureInPictureController(contentSource: source)
        pip.canStartPictureInPictureAutomaticallyFromInline = true
        pip.delegate = self
        controller = pip
    }

    /// 视频轨道换了(连上 / 断开)。画中画开着就把渲染器挪到新轨道上。
    func setTrack(_ newTrack: RTCVideoTrack?) {
        guard newTrack !== track else { return }
        if feeding { track?.remove(renderer) }
        track = newTrack
        if feeding { newTrack?.add(renderer) }
        if newTrack != nil { attach() }
    }

    private func setFeeding(_ on: Bool) {
        guard on != feeding else { return }
        feeding = on
        if on { track?.add(renderer) } else {
            track?.remove(renderer)
            let layer = renderer.displayLayer
            DispatchQueue.main.async { layer.sampleBufferRenderer.flush() }
        }
    }

    func toggle() {
        guard let controller else { return }
        if controller.isPictureInPictureActive { controller.stopPictureInPicture() }
        else {
            let session = AVAudioSession.sharedInstance()
            if savedAudio == nil { savedAudio = (session.category, session.mode, session.categoryOptions) }
            try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
            controller.startPictureInPicture()
        }
    }

    var isActive: Bool { controller?.isPictureInPictureActive ?? false }

    private func ended() {
        isEngaged = false
        setFeeding(false)
        if let saved = savedAudio {
            savedAudio = nil
            try? AVAudioSession.sharedInstance().setCategory(saved.category, mode: saved.mode, options: saved.options)
        }
        onActiveChange?(false)
    }

    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        isEngaged = true
        setFeeding(true)
        onActiveChange?(true)
    }
    func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) { onActiveChange?(true) }
    func pictureInPictureController(_ controller: AVPictureInPictureController,
                                    failedToStartPictureInPictureWithError error: Error) { ended() }
    func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) { ended() }

    func pictureInPictureController(_ controller: AVPictureInPictureController, setPlaying playing: Bool) {}
    func pictureInPictureControllerTimeRangeForPlayback(_ controller: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }
    func pictureInPictureControllerIsPlaybackPaused(_ controller: AVPictureInPictureController) -> Bool { false }
    func pictureInPictureController(_ controller: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}
    func pictureInPictureController(_ controller: AVPictureInPictureController, skipByInterval skipInterval: CMTime) async {}
}
