#!/usr/bin/env node
/**
 * 渲染风暴测量:经 Metro CDP 抓取 React Performance trace(dev-only 排查工具)。
 * ---------------------------------------------------------------------------
 * 用法(模拟器 App 连着 Metro 时,在仓库根或 apps/mobile 下执行):
 *   node apps/mobile/scripts/render-trace.mjs [--seconds 120] [--port 8081] [--out /tmp/render-trace]
 * 采集期间正常操作 App(复现目标场景),到时自动收卷,输出 <out>/trace.json;
 * 再用 render-trace-analyze.mjs 做组件级归因。Ctrl+C 可提前收卷。
 *
 * 背景(2026-07-18 首页重渲染风暴):手机端无落盘日志、hermes 采样 Profiler 域
 * 在新架构不可用,这条 Tracing 管线是拿到「组件名 + 渲染耗时 + Changed Props
 * 供词」的唯一取证通道,也是重构后回归对比的测量基准(配合 js-stall 探测器)。
 *
 * 实现坑位(踩过的都写在这里,别再踩):
 *  - Origin 必须是 http://127.0.0.1:<port>(localhost 会被静默断 1006);
 *  - open 后必须延迟再发首条消息(与 proxy 设备侧装配竞态,立发必断 1006);
 *  - 老 CDP `Profiler` 域在 RN 新架构返回 Unsupported,只能走 `Tracing`。
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let WebSocket;
try {
  // ws 由仓库根依赖树提供(desktop 侧依赖);解析不到时给出明确指引而不是裸栈。
  WebSocket = require('ws');
} catch {
  console.error('无法解析 ws 模块:请在仓库根执行(pnpm install 后),或先 pnpm add -D ws');
  process.exit(1);
}

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const seconds = Number(readArg('seconds', '120'));
const port = Number(readArg('port', '8081'));
const outDir = readArg('out', '/tmp/render-trace');
mkdirSync(outDir, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
if (!Array.isArray(targets) || targets.length === 0) {
  console.error(`Metro(:${port})没有可调试目标——App 是否已连上这个 Metro?`);
  process.exit(1);
}
const wsUrl = targets[0].webSocketDebuggerUrl.replace('localhost', '127.0.0.1');
console.log('target:', targets[0].title ?? wsUrl);

const ws = new WebSocket(wsUrl, { headers: { Origin: `http://127.0.0.1:${port}` } });
let nextId = 1;
const pending = new Map();
const traceEvents = [];
let stopping = false;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('收卷中…');
  try {
    await send('Tracing.end');
  } catch (err) {
    console.error('Tracing.end 失败:', err.message);
    process.exit(1);
  }
}

ws.on('open', async () => {
  await new Promise((r) => setTimeout(r, 800));
  try {
    await send('Tracing.start');
  } catch (err) {
    console.error('Tracing.start 失败:', err.message);
    process.exit(1);
  }
  console.log(`录制中(${seconds}s,Ctrl+C 提前收卷)——现在去 App 里复现目标场景`);
  setTimeout(() => void stop(), seconds * 1000);
  process.on('SIGINT', () => void stop());
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result ?? {});
    return;
  }
  if (msg.method === 'Tracing.dataCollected' && Array.isArray(msg.params?.value)) {
    traceEvents.push(...msg.params.value);
    return;
  }
  if (msg.method === 'Tracing.tracingComplete') {
    const outFile = join(outDir, 'trace.json');
    writeFileSync(outFile, JSON.stringify({ traceEvents }));
    console.log(`已保存 ${traceEvents.length} 条事件 → ${outFile}`);
    console.log(`下一步:node apps/mobile/scripts/render-trace-analyze.mjs ${outFile}`);
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('ws error:', err.message);
});
ws.on('close', (code) => {
  if (!stopping) {
    console.error(`连接被断(code=${code})——Metro 或 App 是否重启了?重跑本脚本即可`);
    process.exit(1);
  }
});
