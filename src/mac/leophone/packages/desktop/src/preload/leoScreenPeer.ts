/**
 * [leo][WP-51/52] 看屏 R1 隐藏窗口的 preload:采屏 + RTCPeerConnection(Mac 是应答方)。契约见 docs/specs/leo-screen.md。
 *
 * 主进程(main/leo/screenPeer.ts)经 "leo:screen-peer:cmd" 下指令,这里回 "leo:screen-peer:reply";
 * 连接状态与 DataChannel 输入事件经 "leo:screen-peer:event" / "leo:screen-peer:input" 报回主进程。
 * 采集走 getDisplayMedia,由主进程的 setDisplayMediaRequestHandler 直接选屏(不弹系统选择器)。
 * 策略(开关、scope、只走 tailnet、ICE 改写)都在 Host,这里只管媒体。
 */
import { ipcRenderer } from "electron";

interface OpenCommand {
  op: "open";
  sessionId: string;
  offer: string;
  maxFps: number;
  maxEdge: number;
  iceServers: RTCIceServer[];
  control: boolean;
}
type Command =
  | OpenCommand
  | { op: "ice"; sessionId: string; candidates: RTCIceCandidateInit[] }
  | { op: "close"; sessionId: string }
  | { op: "stats"; sessionId: string };

interface Peer {
  pc: RTCPeerConnection;
  stream: MediaStream;
  control: boolean;
  disconnectTimer: number | null;
}

const peers = new Map<string, Peer>();
/** 应答前等本机候选收集完(不做 Mac → 手机的 trickle,答案里一次带全);最多等这么久。 */
const GATHER_TIMEOUT_MS = 2_500;
/** 连上后掉线(disconnected)超过这么久就当断开,释放采集。 */
const DISCONNECT_GRACE_MS = 15_000;

const event = (sessionId: string, payload: Record<string, unknown>) =>
  ipcRenderer.send("leo:screen-peer:event", { sessionId, ...payload });

function closePeer(sessionId: string, reason: string): void {
  const peer = peers.get(sessionId);
  if (!peer) return;
  peers.delete(sessionId);
  if (peer.disconnectTimer !== null) window.clearTimeout(peer.disconnectTimer);
  for (const track of peer.stream.getTracks()) track.stop();
  peer.pc.close();
  event(sessionId, { type: "closed", reason });
}

/** H.264 排最前(VideoToolbox 硬编),其中 packetization-mode=1 优先;其余编码保留作兜底。 */
function preferH264(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const score = (codec: RTCRtpCodec) => {
    if (codec.mimeType.toLowerCase() !== "video/h264") return 0;
    return (codec.sdpFmtpLine ?? "").includes("packetization-mode=1") ? 2 : 1;
  };
  return [...codecs].sort((a, b) => score(b) - score(a));
}

function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        resolve();
      }
    });
  });
}

function watchConnection(sessionId: string, peer: Peer): void {
  peer.pc.addEventListener("connectionstatechange", () => {
    const state = peer.pc.connectionState;
    event(sessionId, { type: "state", state });
    if (state === "failed" || state === "closed") closePeer(sessionId, state);
    else if (state === "disconnected" && peer.disconnectTimer === null) {
      peer.disconnectTimer = window.setTimeout(
        () => closePeer(sessionId, "disconnected"),
        DISCONNECT_GRACE_MS,
      );
    } else if (state === "connected" && peer.disconnectTimer !== null) {
      window.clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }
  });
  peer.pc.addEventListener("datachannel", ({ channel }) => {
    // [WP-52] 输入通道:没开 screen.control 的会话直接关掉,手机据此知道只能看。
    if (channel.label !== "leo-input" || !peer.control) {
      channel.close();
      return;
    }
    channel.addEventListener("open", () => event(sessionId, { type: "control", open: true }));
    channel.addEventListener("close", () => event(sessionId, { type: "control", open: false }));
    channel.addEventListener("message", ({ data }) => {
      if (typeof data === "string" && data.length <= 16_384)
        ipcRenderer.send("leo:screen-peer:input", { sessionId, data });
    });
  });
}

async function open(command: OpenCommand): Promise<{ answer: string }> {
  closePeer(command.sessionId, "replaced");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // 长边上限:Retina 原生 3456 宽对手机没必要,缩小后编码更省、静止时码率也低;SCK 采集端直接缩放。
    video: {
      frameRate: { max: command.maxFps },
      width: { max: command.maxEdge },
      height: { max: command.maxEdge },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("没有拿到屏幕画面");
  // 屏幕内容:优先保清晰(文字),带宽不够时降帧不降分辨率。
  track.contentHint = "detail";
  const pc = new RTCPeerConnection({
    iceServers: command.iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });
  const peer: Peer = { pc, stream, control: command.control, disconnectTimer: null };
  peers.set(command.sessionId, peer);
  watchConnection(command.sessionId, peer);
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: command.offer });
    const transceiver = pc
      .getTransceivers()
      .find((item) => item.receiver.track.kind === "video" && item.currentDirection !== "stopped");
    if (!transceiver) throw new Error("offer 里没有视频(手机要 addTransceiver(video, recvonly))");
    transceiver.direction = "sendonly";
    await transceiver.sender.replaceTrack(track);
    const capabilities = RTCRtpSender.getCapabilities("video");
    if (capabilities) transceiver.setCodecPreferences(preferH264(capabilities.codecs));
    const parameters = transceiver.sender.getParameters();
    parameters.degradationPreference = "maintain-resolution";
    for (const encoding of parameters.encodings) encoding.maxFramerate = command.maxFps;
    await transceiver.sender.setParameters(parameters).catch(() => undefined);
    await pc.setLocalDescription(await pc.createAnswer());
    // 发送端用哪种编码由对端 offer 的顺序决定(JSEP),答案里排第一没用;手机若把 VP8 排前面就会走 libvpx 软编。
    // 用 encodings[].codec 明确指定协商结果里的 H.264(VideoToolbox 硬编)。
    const negotiated = transceiver.sender.getParameters();
    const h264 =
      negotiated.codecs.find(
        (codec) =>
          codec.mimeType.toLowerCase() === "video/h264" &&
          (codec.sdpFmtpLine ?? "").includes("packetization-mode=1"),
      ) ?? negotiated.codecs.find((codec) => codec.mimeType.toLowerCase() === "video/h264");
    if (h264 && negotiated.encodings[0]) {
      // TS 的 DOM 类型还没有 encodings[].codec(Chromium 126+ 已支持)。
      (negotiated.encodings[0] as RTCRtpEncodingParameters & { codec?: RTCRtpCodec }).codec = h264;
      await transceiver.sender.setParameters(negotiated).catch(() => undefined);
    }
    await waitForGathering(pc);
    return { answer: pc.localDescription?.sdp ?? "" };
  } catch (error) {
    closePeer(command.sessionId, "negotiation_failed");
    throw error;
  }
}

/** 给手机 / 测试客户端看的摘要:编码器(VideoToolbox 即硬编)、帧率、码率、选中的候选对。 */
async function stats(sessionId: string): Promise<Record<string, unknown>> {
  const peer = peers.get(sessionId);
  if (!peer) return { state: "closed" };
  const report = await peer.pc.getStats();
  const out: Record<string, unknown> = { state: peer.pc.connectionState };
  const byId = new Map<string, Record<string, unknown>>();
  report.forEach((value: Record<string, unknown>) => byId.set(String(value["id"]), value));
  for (const value of byId.values()) {
    if (value["type"] === "outbound-rtp" && value["kind"] === "video") {
      const codec = byId.get(String(value["codecId"]));
      Object.assign(out, {
        encoder: value["encoderImplementation"] ?? null,
        power_efficient_encoder: value["powerEfficientEncoder"] ?? null,
        codec: codec?.["mimeType"] ?? null,
        frame_width: value["frameWidth"] ?? null,
        frame_height: value["frameHeight"] ?? null,
        frames_per_second: value["framesPerSecond"] ?? null,
        frames_encoded: value["framesEncoded"] ?? null,
        bytes_sent: value["bytesSent"] ?? null,
        total_encode_time: value["totalEncodeTime"] ?? null,
        quality_limitation: value["qualityLimitationReason"] ?? null,
        timestamp: value["timestamp"] ?? null,
      });
    }
    if (
      value["type"] === "candidate-pair" &&
      value["nominated"] &&
      value["state"] === "succeeded"
    ) {
      const local = byId.get(String(value["localCandidateId"]));
      const remote = byId.get(String(value["remoteCandidateId"]));
      Object.assign(out, {
        rtt_ms:
          typeof value["currentRoundTripTime"] === "number"
            ? Math.round(value["currentRoundTripTime"] * 1000)
            : null,
        local_candidate: local ? `${local["candidateType"]} ${local["address"]}` : null,
        remote_candidate: remote ? `${remote["candidateType"]} ${remote["address"]}` : null,
      });
    }
  }
  return out;
}

async function run(command: Command): Promise<unknown> {
  switch (command.op) {
    case "open":
      return open(command);
    case "ice": {
      const peer = peers.get(command.sessionId);
      if (!peer) throw new Error("会话已结束");
      for (const candidate of command.candidates) await peer.pc.addIceCandidate(candidate);
      return { ok: true };
    }
    case "close":
      closePeer(command.sessionId, "closed_by_client");
      return { ok: true };
    case "stats":
      return stats(command.sessionId);
  }
}

ipcRenderer.on("leo:screen-peer:cmd", (_event, message: { id: number; command: Command }) => {
  void run(message.command).then(
    (result) => ipcRenderer.send("leo:screen-peer:reply", { id: message.id, result }),
    (error: unknown) =>
      ipcRenderer.send("leo:screen-peer:reply", {
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
