/**
 * fetch-with-timeout — 给 agent 二进制下载链路的上游请求加超时控制。
 *
 * 背景：claude/codex/ripgrep 二进制移出 LFS 后改为从上游（downloads.claude.ai / api.github.com）
 * 按需下载，国内网络常出现"连不上 / 卡死 / 持续低速拖很久"三类慢。裸 `fetch` 没有超时，
 * 慢的时候会一直挂住，既不报错也不回退。本模块把这几类慢都转成可识别的 TimeoutError，
 * 让上层（ensure-agent-binaries）据此回退到国内 CDN 兜底。
 *
 * 四类超时（均可经 env 覆盖，无需改代码即可按个人网络实测调）：
 *   - connectTimeoutMs (XDT_AGENTBIN_CONNECT_TIMEOUT_MS, 默认 10s): 拿到响应头的超时（连不上）
 *   - stallTimeoutMs   (XDT_AGENTBIN_STALL_TIMEOUT_MS,   默认 15s): 下载中连续无字节进展（卡死）
 *   - totalTimeoutMs   (XDT_AGENTBIN_TOTAL_TIMEOUT_MS,   默认 30min): 整段下载总时长上限（无限拖兜底）
 *     （二进制体量已到百 MB 级，国内直连官方源实测 ~1MB/s，旧的 60s 上限会掐断正常慢速下载；
 *      "连不上/卡死"仍由 connect/stall 快速兜底，total 只防"无限拖"，故放宽到 30min。
 *      注意 30min 默认只用于大文件下载；JSON 元数据小请求默认仍 60s，见 fetchJsonWithTimeout）
 *   - minThroughputBytesPerSec (XDT_AGENTBIN_MIN_THROUGHPUT_BPS, 默认 200KB/s，0 = 禁用):
 *     滚动窗口平均吞吐下限（持续低速）。窗口 throughputWindowMs
 *     (XDT_AGENTBIN_THROUGHPUT_WINDOW_MS, 默认 30s) 内平均速度低于下限即放弃——
 *     这是"龟速但一直有进展"场景的主判定：stall 只认零字节抓不到它，等 total 30min 又太久。
 *     窗口攒满一整段才开始评估（下载起步/瞬时抖动不计），阈值按"上游正常 ~1MB/s、CDN 兜底
 *     可用"标定。⚠️ 只有"放弃后有别处可去"的调用方才应启用：install 链路
 *     （ensure-agent-binaries → ensurePlatform，有 CDN 兜底）开启；update CLI 直连上游
 *     无兜底、CDN 兜底自身是最后一道，均显式传 0 禁用——没有退路时掐断只会把
 *     "慢但能成"变成失败。
 *
 * 纯 node（被 tools/<kind>/update.mjs 与 scripts/agent-binary-cdn-fallback.mjs 复用）——
 * 不能依赖 Electron 的 main 进程 downloader（那个 import 了 electron 的 net）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 可识别的超时错误；kind 区分是哪类超时，便于日志与上层判断。 */
export class TimeoutError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
    this.kind = kind; // 'connect' | 'stall' | 'total' | 'throughput'
  }
}

const DEFAULTS = {
  connectTimeoutMs: 10_000,
  stallTimeoutMs: 15_000,
  totalTimeoutMs: 1_800_000,
  minThroughputBytesPerSec: 200_000,
  throughputWindowMs: 30_000,
};

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 同 envInt，但 0 是合法值（吞吐下限的 0 = 禁用检查）。 */
function envIntAllowZero(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 解析各超时/吞吐阈值：显式入参 > env 覆盖 > 默认值。 */
export function resolveTimeouts(overrides = {}) {
  return {
    connectTimeoutMs: overrides.connectTimeoutMs ?? envInt('XDT_AGENTBIN_CONNECT_TIMEOUT_MS', DEFAULTS.connectTimeoutMs),
    stallTimeoutMs: overrides.stallTimeoutMs ?? envInt('XDT_AGENTBIN_STALL_TIMEOUT_MS', DEFAULTS.stallTimeoutMs),
    totalTimeoutMs: overrides.totalTimeoutMs ?? envInt('XDT_AGENTBIN_TOTAL_TIMEOUT_MS', DEFAULTS.totalTimeoutMs),
    minThroughputBytesPerSec:
      overrides.minThroughputBytesPerSec ?? envIntAllowZero('XDT_AGENTBIN_MIN_THROUGHPUT_BPS', DEFAULTS.minThroughputBytesPerSec),
    throughputWindowMs: overrides.throughputWindowMs ?? envInt('XDT_AGENTBIN_THROUGHPUT_WINDOW_MS', DEFAULTS.throughputWindowMs),
  };
}

/** fetch 因我方 abort 而失败时，把 reason（TimeoutError）取回；否则原样 rethrow。 */
function rethrowAbort(err, controller) {
  const reason = controller.signal.reason;
  if (reason instanceof TimeoutError) return reason;
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return new TimeoutError(`aborted: ${err.message}`, 'connect');
  }
  return err;
}

/** JSON 元数据请求的默认 deadline——小请求不适用下载的 30min 默认，挂住 60s 就该报错。 */
const JSON_TOTAL_TIMEOUT_MS = 60_000;

/** 进度行渲染（纯函数，便于测试）：`42% 84.0/200.0MB @ 1.2MB/s`；总大小未知时省略百分比。 */
export function formatProgressLine({ receivedBytes, totalBytes, bytesPerSec }) {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const speed = `${mb(bytesPerSec)}MB/s`;
  if (totalBytes) {
    const pct = Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
    return `${pct}% ${mb(receivedBytes)}/${mb(totalBytes)}MB @ ${speed}`;
  }
  return `${mb(receivedBytes)}MB @ ${speed}`;
}

/**
 * 下载进度渲染器：返回 { onProgress, finish }，onProgress 接给 downloadToFileWithTimeout，
 * finish 在下载结束（无论成败）后调用收尾。
 * - TTY：单行 \r 原地刷新（默认每 500ms），finish 补换行，不留半行残迹。
 * - 非 TTY（agent / CI / 重定向日志）：降频整行输出（默认每 5s），避免进度刷屏。
 * options.writeLine 可注入输出通道（测试用）；注入后 finish 不再补换行。
 */
export function createDownloadProgressLogger(label, options = {}) {
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  const intervalMs = options.intervalMs ?? (isTTY ? 500 : 5_000);
  const writeLine = options.writeLine ?? null;
  let lastPrintAt = 0;
  let lastBytes = 0;
  let lastAt = Date.now();
  let printedInPlace = false;

  const onProgress = ({ receivedBytes, totalBytes }) => {
    const now = Date.now();
    if (now - lastPrintAt < intervalMs) return;
    const bytesPerSec = ((receivedBytes - lastBytes) * 1000) / Math.max(1, now - lastAt);
    lastPrintAt = now;
    lastBytes = receivedBytes;
    lastAt = now;
    const line = `  [${label}] ${formatProgressLine({ receivedBytes, totalBytes, bytesPerSec })}`;
    if (writeLine) {
      writeLine(line);
    } else if (isTTY) {
      process.stdout.write(`\r${line.padEnd(64)}`);
      printedInPlace = true;
    } else {
      console.log(line);
    }
  };

  const finish = () => {
    if (printedInPlace) {
      process.stdout.write('\n');
      printedInPlace = false;
    }
  };

  return { onProgress, finish };
}

/**
 * 小请求（JSON 元数据）：fetch + 读取 JSON，单一 deadline 覆盖整段。
 * deadline 取值：显式入参 > XDT_AGENTBIN_TOTAL_TIMEOUT_MS > 60s（不是下载的 30min 默认）。
 * 失败（非 2xx / 超时 / 网络错）抛错；成功返回已解析的 JSON。
 */
export async function fetchJsonWithTimeout(url, init = {}, overrides = {}) {
  const totalTimeoutMs = overrides.totalTimeoutMs ?? envInt('XDT_AGENTBIN_TOTAL_TIMEOUT_MS', JSON_TOTAL_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TimeoutError(`timeout ${totalTimeoutMs}ms fetching ${url}`, 'total')),
    totalTimeoutMs,
  );
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
    return await res.json();
  } catch (err) {
    throw rethrowAbort(err, controller);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 大文件流式下载到 destPath，带 connect / stall / total / throughput 四类超时。
 * 经 `${destPath}.part` 中转后原子 rename，失败清理残留。
 * overrides.onProgress?: ({ receivedBytes, totalBytes }) => void —— body 每收到一块数据回调一次，
 * totalBytes 来自 Content-Length（chunked 响应拿不到时为 null）；回调抛错不影响下载。
 * 返回 { size }。非 2xx / 超时 / 网络错均抛错（TimeoutError 或带 status 的 Error）。
 */
export async function downloadToFileWithTimeout(url, destPath, init = {}, overrides = {}) {
  const { connectTimeoutMs, stallTimeoutMs, totalTimeoutMs, minThroughputBytesPerSec, throughputWindowMs } =
    resolveTimeouts(overrides);
  const onProgress = typeof overrides.onProgress === 'function' ? overrides.onProgress : null;
  const controller = new AbortController();
  let lastProgress = Date.now();
  let totalBytes = 0;
  let bodyStarted = false;

  const connectTimer = setTimeout(
    () => controller.abort(new TimeoutError(`connect timeout ${connectTimeoutMs}ms: ${url}`, 'connect')),
    connectTimeoutMs,
  );
  const totalTimer = setTimeout(
    () => controller.abort(new TimeoutError(`total timeout ${totalTimeoutMs}ms: ${url}`, 'total')),
    totalTimeoutMs,
  );
  // stall：周期性检查"距上次收到字节"是否超过 stallTimeoutMs。
  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgress > stallTimeoutMs) {
      controller.abort(new TimeoutError(`stall timeout ${stallTimeoutMs}ms (no bytes): ${url}`, 'stall'));
    }
  }, Math.min(stallTimeoutMs, 5_000));
  if (typeof stallTimer.unref === 'function') stallTimer.unref();

  // throughput：body 阶段每 tick 采样累计字节数，窗口攒满一整段后按
  // "窗口内平均速度 < 下限"判定持续低速——stall 抓不到"有进展但龟速"，这里补上。
  // 采样保留一个落在窗口起点之前的 baseline，保证评估跨度 ≥ 完整窗口。
  const samples = [];
  let throughputTimer = null;
  if (minThroughputBytesPerSec > 0) {
    const tickMs = Math.max(100, Math.min(Math.floor(throughputWindowMs / 4), 5_000));
    throughputTimer = setInterval(() => {
      if (!bodyStarted) return;
      const now = Date.now();
      samples.push({ t: now, bytes: totalBytes });
      while (samples.length > 1 && samples[1].t <= now - throughputWindowMs) samples.shift();
      const baseline = samples[0];
      if (now - baseline.t < throughputWindowMs) return; // 窗口未攒满，不评估
      const bps = ((totalBytes - baseline.bytes) * 1000) / (now - baseline.t);
      if (bps < minThroughputBytesPerSec) {
        controller.abort(new TimeoutError(
          `throughput below ${minThroughputBytesPerSec}B/s over ${throughputWindowMs}ms (avg ${Math.round(bps)}B/s): ${url}`,
          'throughput',
        ));
      }
    }, tickMs);
    if (typeof throughputTimer.unref === 'function') throughputTimer.unref();
  }

  const partPath = `${destPath}.part`;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(connectTimer); // 响应头已到，连接超时解除（stall + total + throughput 接管 body 阶段）
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
    if (!res.body) throw new Error(`Empty response body: ${url}`);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    bodyStarted = true;
    const contentLength = Number(res.headers.get('content-length'));
    const expectedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      lastProgress = Date.now();
      totalBytes += chunk.length;
      if (onProgress) {
        try { onProgress({ receivedBytes: totalBytes, totalBytes: expectedTotal }); } catch { /* 进度回调不影响下载 */ }
      }
    });
    await pipeline(body, fs.createWriteStream(partPath));

    fs.renameSync(partPath, destPath);
    return { size: fs.statSync(destPath).size };
  } catch (err) {
    try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    throw rethrowAbort(err, controller);
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    clearInterval(stallTimer);
    if (throughputTimer) clearInterval(throughputTimer);
  }
}
