#!/usr/bin/env node
// [leo][WP-51/52] 看屏 R1/R2 的本机测试客户端(开发用,不进安装包)。契约见 docs/specs/leo-screen.md。
//
// 用一个独立的无头 Chrome 当「手机」(同为 libwebrtc,和 iOS 的 stasel/WebRTC 一致):
//   1. Chrome 里建 recvonly 视频 + 可选 leo-input DataChannel,出 offer;
//   2. 本脚本把 offer POST 到 Mac 直连口 /screen/session(带直连授权),拿 answer 回填,trickle 候选;
//   3. 采样统计:接收端帧率 / 码率 / 解码器,Mac 端 GET /screen/session/:id(编码器是否 VideoToolbox)。
//   --latency:另开一个小的可见 Chrome 窗口(测试自己开的窗口),背景色按时间编码,接收端从解码帧取色,
//              算「画面变化 → 解码出来」的端到端延迟;之后冻结颜色测静止码率。
//   --input <file>:[WP-52] 经 DataChannel 依次发送文件里的输入事件(JSON 数组)。
//
// 用法:node client.mjs --base http://127.0.0.1:38498 --grant grant.json [--seconds 10] [--latency]
//        [--control] [--input events.json] [--fps 30] [--max-edge 1920]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const base = option("--base", "http://127.0.0.1:38498");
const grantFile = option("--grant", "grant.json");
const seconds = Number(option("--seconds", "10"));
const fps = Number(option("--fps", "30"));
const chromePath = option(
  "--chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
);
const { device, grant } = JSON.parse(readFileSync(grantFile, "utf8"));

let requestCounter = 0;
async function link(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${grant.token}`,
      "x-leo-device-id": device.deviceId ?? grant.targetDeviceId,
      "content-type": "application/json",
      ...(method === "POST"
        ? { "x-request-id": `screen-test-${Date.now()}-${requestCounter++}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

/** 最小 CDP:开一个 Chrome、拿 page 的 websocket、Runtime.evaluate。 */
async function launchChrome(port, extra) {
  const profile = mkdtempSync(join(tmpdir(), "leo-screen-client-"));
  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      ...extra,
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((item) => item.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve, { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
        let id = 0;
        const waiting = new Map();
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        });
        const evaluate = (expression) =>
          new Promise((resolve, reject) => {
            const current = ++id;
            waiting.set(current, (message) => {
              const result = message.result;
              if (result?.exceptionDetails)
                reject(
                  new Error(result.exceptionDetails.exception?.description ?? "evaluate failed"),
                );
              else resolve(result?.result?.value);
            });
            ws.send(
              JSON.stringify({
                id: current,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              }),
            );
          });
        return {
          evaluate,
          close() {
            ws.close();
            child.kill();
            setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
          },
        };
      }
    } catch {
      // Chrome 还没起来。
    }
    await sleep(200);
  }
  child.kill();
  throw new Error("Chrome 没有起来");
}

// 「手机」端:无头 Chrome,只收视频。
const RECEIVER_SETUP = `(async () => {
  const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  window.pc = pc;
  window.localCandidates = [];
  pc.onicecandidate = (e) => { if (e.candidate) window.localCandidates.push(e.candidate.toJSON()); };
  pc.addTransceiver("video", { direction: "recvonly" });
  if (${flag("--control") || flag("--input")}) {
    window.input = pc.createDataChannel("leo-input", { ordered: true });
    window.inputOpen = new Promise((resolve) => { window.input.onopen = () => resolve(true); window.input.onclose = () => resolve(false); });
  }
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  document.body.appendChild(video);
  window.video = video;
  // 像 iOS 一样把接收端抖动缓冲压到最小(看屏不要求平滑),测出的就是 Mac 侧 + 网络的延迟。
  pc.ontrack = (e) => { if ("jitterBufferTarget" in e.receiver) e.receiver.jitterBufferTarget = 0; video.srcObject = new MediaStream([e.track]); video.play().catch(() => {}); };
  await pc.setLocalDescription(await pc.createOffer());
  return pc.localDescription.sdp;
})()`;

// 背景色 = 时间(4ms 一档,12 位,约 16 秒一圈),每档每通道 16 级,抗压缩误差。
const COLOR_PAGE = `data:text/html,${encodeURIComponent(`<html><body style="margin:0"><script>
window.frozen=false;
function paint(){ if(!window.frozen){ const t=Math.floor(Date.now()/4)%4096;
 document.body.style.background='rgb('+(((t>>8)&15)*16+8)+','+(((t>>4)&15)*16+8)+','+((t&15)*16+8)+')'; }
 requestAnimationFrame(paint); } paint();
</script></body></html>`)}`;

const SAMPLE_LATENCY = (x, y) => `(() => {
  const v = window.video; if (!v.videoWidth) return null;
  const c = window.canvas ??= document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0);
  const px = ctx.getImageData(Math.round(${x} * v.videoWidth), Math.round(${y} * v.videoHeight), 1, 1).data;
  const level = (value) => Math.max(0, Math.min(15, Math.round((value - 8) / 16)));
  const t = (level(px[0]) << 8) | (level(px[1]) << 4) | level(px[2]);
  const now = Math.floor(Date.now() / 4) % 4096;
  if (window.debugSamples !== undefined) window.debugSamples.push([...px].slice(0, 3).join(","));
  return ((now - t + 4096) % 4096) * 4;
})()`;

const RECEIVER_STATS = `(async () => {
  const out = {};
  (await window.pc.getStats()).forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video") Object.assign(out, {
      bytes: s.bytesReceived, frames: s.framesDecoded, fps: s.framesPerSecond, width: s.frameWidth,
      height: s.frameHeight, decoder: s.decoderImplementation, jitter_buffer_ms:
        s.jitterBufferEmittedCount ? (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000 : null,
      decode_ms: s.framesDecoded ? (s.totalDecodeTime / s.framesDecoded) * 1000 : null,
      ts: s.timestamp });
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded")
      out.rtt_ms = s.currentRoundTripTime * 1000;
  });
  out.state = window.pc.connectionState;
  return out;
})()`;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

async function main() {
  const receiver = await launchChrome(9333, ["--headless=new", "about:blank"]);
  let colorWindow = null;
  let sessionId = null;
  try {
    const offer = await receiver.evaluate(RECEIVER_SETUP);
    const opened = await link("POST", "/screen/session", {
      offer,
      max_fps: fps,
      max_edge: Number(option("--max-edge", "1920")),
      ...(flag("--control") || flag("--input") ? { control: true } : {}),
    });
    if (opened.status !== 200)
      throw new Error(`open ${opened.status} ${JSON.stringify(opened.body)}`);
    sessionId = opened.body.session_id;
    console.log(
      `session ${sessionId} tiers=${opened.body.candidate_tiers.join(",")} control=${opened.body.control} tailnet_only=${opened.body.tailnet_only}`,
    );
    if (process.env.LEO_SCREEN_DEBUG)
      console.log(
        opened.body.answer
          .split(/\r?\n/)
          .filter((l) => /^m=|a=rtpmap/.test(l))
          .slice(0, 6)
          .join("\n"),
      );
    const t0 = Date.now();
    await receiver.evaluate(
      `window.pc.setRemoteDescription({ type: "answer", sdp: ${JSON.stringify(opened.body.answer)} }).then(() => true)`,
    );
    const candidates = await receiver.evaluate("window.localCandidates");
    if (candidates.length) {
      const ice = await link("POST", `/screen/session/${sessionId}/ice`, { candidates });
      console.log(`ice ${ice.status} ${JSON.stringify(ice.body)}`);
    }
    for (let i = 0; i < 100; i += 1) {
      const state = await receiver.evaluate("window.pc.connectionState");
      if (state === "connected") break;
      if (state === "failed") throw new Error("ICE failed");
      await sleep(100);
    }
    const first = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (await receiver.evaluate("window.video.videoWidth > 0")) return Date.now() - t0;
        await sleep(50);
      }
      return null;
    })();
    console.log(`connected; first frame after ${first}ms from answer`);

    if (flag("--latency")) {
      colorWindow = await launchChrome(9334, [
        "--window-position=40,80",
        "--window-size=360,240",
        `--app=${COLOR_PAGE}`,
      ]);
      await sleep(1500);
      const geometry = await colorWindow.evaluate(
        "({ x: (window.screenX + window.innerWidth / 2) / screen.width, y: (window.screenY + (window.outerHeight - window.innerHeight) + window.innerHeight / 2) / screen.height })",
      );
      const samples = [];
      if (process.env.LEO_SCREEN_DEBUG) await receiver.evaluate("window.debugSamples = []");
      console.log(`sample point ${JSON.stringify(geometry)}`);
      const until = Date.now() + seconds * 1000;
      const before = await receiver.evaluate(RECEIVER_STATS);
      while (Date.now() < until) {
        const value = await receiver.evaluate(SAMPLE_LATENCY(geometry.x, geometry.y));
        if (typeof value === "number" && value < 2000) samples.push(value);
        await sleep(97);
      }
      const after = await receiver.evaluate(RECEIVER_STATS);
      const mac = await link("GET", `/screen/session/${sessionId}`);
      report("dynamic", before, after, mac.body);
      console.log(
        `latency glass-to-glass (screen change → decoded frame, incl. one canvas read): median ${median(samples)}ms, p90 ${[...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.9)]}ms, n=${samples.length}`,
      );
      if (process.env.LEO_SCREEN_DEBUG)
        console.log(
          `raw ${JSON.stringify((await receiver.evaluate("window.debugSamples")).slice(0, 12))}`,
        );
      await colorWindow.evaluate("window.frozen = true");
      await sleep(2000);
    }
    if (flag("--input")) {
      const events = JSON.parse(readFileSync(option("--input", ""), "utf8"));
      const open = await receiver.evaluate("window.inputOpen");
      console.log(`input channel open=${open}`);
      if (open) {
        for (const item of events) {
          if (item.sleep_ms) await sleep(item.sleep_ms);
          else
            await receiver.evaluate(`window.input.send(${JSON.stringify(JSON.stringify(item))})`);
        }
        await sleep(500);
        console.log(`sent ${events.filter((item) => !item.sleep_ms).length} input events`);
      }
    }
    const before = await receiver.evaluate(RECEIVER_STATS);
    await sleep(seconds * 1000);
    const after = await receiver.evaluate(RECEIVER_STATS);
    const mac = await link("GET", `/screen/session/${sessionId}`);
    report(flag("--latency") ? "static" : "steady", before, after, mac.body);
  } finally {
    if (sessionId) {
      const closed = await link("DELETE", `/screen/session/${sessionId}`);
      console.log(`delete ${closed.status}`);
    }
    colorWindow?.close();
    receiver.close();
  }
}

function report(label, before, after, mac) {
  const seconds = (after.ts - before.ts) / 1000;
  const kbps = (((after.bytes - before.bytes) * 8) / seconds / 1000).toFixed(0);
  const fpsMeasured = ((after.frames - before.frames) / seconds).toFixed(1);
  console.log(
    `[${label}] ${seconds.toFixed(1)}s ${after.width}x${after.height} recv ${fpsMeasured}fps ${kbps}kbps decoder=${after.decoder} jitterbuf=${after.jitter_buffer_ms?.toFixed(0)}ms decode=${after.decode_ms?.toFixed(1)}ms rtt=${after.rtt_ms?.toFixed(1)}ms`,
  );
  console.log(
    `[${label}] mac encoder=${mac.encoder} power_efficient=${mac.power_efficient_encoder} codec=${mac.codec} send ${mac.frames_per_second}fps ${mac.frame_width}x${mac.frame_height} limit=${mac.quality_limitation} pair=${mac.local_candidate} -> ${mac.remote_candidate}`,
  );
}

await main();
