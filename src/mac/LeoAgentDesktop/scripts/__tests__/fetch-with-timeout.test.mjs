// fetch-with-timeout 单测：验证三类超时与正常路径。
// 用 node 内置 http server mock 上游，node 内置 test runner，无 vitest 依赖。
// 直接 `node --test scripts/__tests__/fetch-with-timeout.test.mjs`。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TimeoutError,
  resolveTimeouts,
  fetchJsonWithTimeout,
  downloadToFileWithTimeout,
  formatProgressLine,
  createDownloadProgressLogger,
} from '../../tools/shared/fetch-with-timeout.mjs';

// ── mock server：按路径模拟正常 / 慢 / 错误响应 ──────────────────────────────
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    } else if (req.url === '/notfound') {
      res.writeHead(404);
      res.end('nope');
    } else if (req.url === '/slow.json') {
      // 永不响应——触发 total 超时
      // (故意不调用 res.end)
    } else if (req.url === '/noheaders') {
      // 永不发响应头——触发 connect 超时
    } else if (req.url === '/file') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' });
      res.end(Buffer.alloc(4096, 7));
    } else if (req.url === '/trickle') {
      // 龟速但持续有进展：每 50ms 吐 1 字节，stall 抓不到，靠 throughput 判定掐断。
      // 不主动 end——由客户端 abort 收尾（连接关闭时清理 interval）。
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const timer = setInterval(() => res.write(Buffer.alloc(1, 7)), 50);
      res.on('close', () => clearInterval(timer));
    } else if (req.url === '/trickle-short') {
      // 龟速但很快就正常结束：吐 5 字节后 end，用于验证"吞吐判定禁用/未触发时不误伤"。
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      let n = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(1, 7));
        if (++n >= 5) { clearInterval(timer); res.end(); }
      }, 50);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(500);
      res.end('err');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwt-test-'));
  return path.join(dir, name);
}

test('resolveTimeouts: env 覆盖 > 默认值', () => {
  const def = resolveTimeouts();
  assert.equal(def.connectTimeoutMs, 10_000);
  assert.equal(def.stallTimeoutMs, 15_000);
  assert.equal(def.totalTimeoutMs, 1_800_000);
  assert.equal(def.minThroughputBytesPerSec, 200_000);
  assert.equal(def.throughputWindowMs, 30_000);
  assert.equal(resolveTimeouts({ connectTimeoutMs: 1234 }).connectTimeoutMs, 1234);

  process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS = '4242';
  assert.equal(resolveTimeouts().totalTimeoutMs, 4242);
  delete process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS;
});

test('resolveTimeouts: 吞吐下限 env 允许 0（禁用），窗口 env 不允许 0', () => {
  process.env.XDT_AGENTBIN_MIN_THROUGHPUT_BPS = '0';
  process.env.XDT_AGENTBIN_THROUGHPUT_WINDOW_MS = '0';
  try {
    const r = resolveTimeouts();
    assert.equal(r.minThroughputBytesPerSec, 0); // 0 = 禁用，合法
    assert.equal(r.throughputWindowMs, 30_000); // 0 非法，回默认
  } finally {
    delete process.env.XDT_AGENTBIN_MIN_THROUGHPUT_BPS;
    delete process.env.XDT_AGENTBIN_THROUGHPUT_WINDOW_MS;
  }
  // 显式入参 0 同样表示禁用
  assert.equal(resolveTimeouts({ minThroughputBytesPerSec: 0 }).minThroughputBytesPerSec, 0);
});

test('fetchJsonWithTimeout: 正常返回解析后的 JSON', async () => {
  const json = await fetchJsonWithTimeout(`${base}/ok.json`);
  assert.deepEqual(json, { hello: 'world' });
});

test('fetchJsonWithTimeout: 非 2xx 抛错（带 status + url）', async () => {
  await assert.rejects(() => fetchJsonWithTimeout(`${base}/notfound`), /HTTP 404/);
});

test('fetchJsonWithTimeout: total 超时抛 TimeoutError(kind=total)', async () => {
  await assert.rejects(
    () => fetchJsonWithTimeout(`${base}/slow.json`, {}, { totalTimeoutMs: 150 }),
    (err) => err instanceof TimeoutError && err.kind === 'total',
  );
});

test('fetchJsonWithTimeout: env 覆盖 JSON deadline(优先于 60s 默认)', async () => {
  process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS = '150';
  try {
    await assert.rejects(
      () => fetchJsonWithTimeout(`${base}/slow.json`),
      (err) => err instanceof TimeoutError && err.kind === 'total',
    );
  } finally {
    delete process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS;
  }
});

test('fetchJsonWithTimeout: 显式入参优先于 env', async () => {
  // env 给大值,显式入参给 150ms —— 若显式没赢,本用例会等到 env 值(远超测试超时)才失败。
  process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS = '600000';
  try {
    await assert.rejects(
      () => fetchJsonWithTimeout(`${base}/slow.json`, {}, { totalTimeoutMs: 150 }),
      (err) => err instanceof TimeoutError && err.kind === 'total',
    );
  } finally {
    delete process.env.XDT_AGENTBIN_TOTAL_TIMEOUT_MS;
  }
});

test('downloadToFileWithTimeout: 正常下载落盘', async () => {
  const dest = tmpPath('bin');
  const { size } = await downloadToFileWithTimeout(`${base}/file`, dest);
  assert.equal(size, 4096);
  assert.equal(fs.statSync(dest).size, 4096);
  // .part 中转文件应已清理
  assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('downloadToFileWithTimeout: connect 超时抛 TimeoutError(kind=connect)，清理 .part', async () => {
  const dest = tmpPath('bin');
  await assert.rejects(
    () => downloadToFileWithTimeout(`${base}/noheaders`, dest, {}, { connectTimeoutMs: 150 }),
    (err) => err instanceof TimeoutError && err.kind === 'connect',
  );
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(fs.existsSync(dest), false);
});

test('downloadToFileWithTimeout: 非 2xx 抛错', async () => {
  const dest = tmpPath('bin');
  await assert.rejects(() => downloadToFileWithTimeout(`${base}/notfound`, dest), /HTTP 404/);
});

test('downloadToFileWithTimeout: 持续龟速抛 TimeoutError(kind=throughput)，清理 .part', async () => {
  const dest = tmpPath('bin');
  // trickle ~20B/s；窗口 400ms（采样 tick=100ms）、下限 10KB/s → 窗口攒满即触发。
  // stall/total 给大值，确保是 throughput 先掐断而不是别的超时误报。
  await assert.rejects(
    () => downloadToFileWithTimeout(`${base}/trickle`, dest, {}, {
      minThroughputBytesPerSec: 10_000,
      throughputWindowMs: 400,
      stallTimeoutMs: 10_000,
      totalTimeoutMs: 60_000,
    }),
    (err) => err instanceof TimeoutError && err.kind === 'throughput',
  );
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(fs.existsSync(dest), false);
});

test('downloadToFileWithTimeout: minThroughputBytesPerSec=0 禁用吞吐判定，龟速下载可完成', async () => {
  const dest = tmpPath('bin');
  const { size } = await downloadToFileWithTimeout(`${base}/trickle-short`, dest, {}, {
    minThroughputBytesPerSec: 0,
    throughputWindowMs: 400,
    stallTimeoutMs: 10_000,
    totalTimeoutMs: 60_000,
  });
  assert.equal(size, 5);
});

test('downloadToFileWithTimeout: onProgress 收到累计字节与 Content-Length 总大小', async () => {
  const dest = tmpPath('bin');
  const calls = [];
  await downloadToFileWithTimeout(`${base}/file`, dest, {}, {
    onProgress: (p) => calls.push(p),
  });
  assert.ok(calls.length >= 1);
  const last = calls[calls.length - 1];
  assert.equal(last.receivedBytes, 4096);
  assert.equal(last.totalBytes, 4096); // 来自响应头 Content-Length
  // receivedBytes 单调递增
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].receivedBytes >= calls[i - 1].receivedBytes);
});

test('downloadToFileWithTimeout: chunked 响应 totalBytes 为 null，回调抛错不影响下载', async () => {
  const dest = tmpPath('bin');
  const calls = [];
  const { size } = await downloadToFileWithTimeout(`${base}/trickle-short`, dest, {}, {
    minThroughputBytesPerSec: 0,
    onProgress: (p) => {
      calls.push(p);
      throw new Error('progress callback boom'); // 不应让下载失败
    },
  });
  assert.equal(size, 5);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].totalBytes, null); // res.write 流式响应无 Content-Length
});

test('formatProgressLine: 有/无总大小两种形态', () => {
  assert.equal(
    formatProgressLine({ receivedBytes: 100 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, bytesPerSec: 1.5 * 1024 * 1024 }),
    '50% 100.0/200.0MB @ 1.5MB/s',
  );
  assert.equal(
    formatProgressLine({ receivedBytes: 3 * 1024 * 1024, totalBytes: null, bytesPerSec: 512 * 1024 }),
    '3.0MB @ 0.5MB/s',
  );
});

test('createDownloadProgressLogger: 按 intervalMs 节流，输出走注入的 writeLine', async () => {
  const lines = [];
  const { onProgress, finish } = createDownloadProgressLogger('claude darwin-arm64', {
    intervalMs: 50,
    writeLine: (l) => lines.push(l),
  });
  onProgress({ receivedBytes: 1024, totalBytes: 4096 }); // 首次立即输出
  onProgress({ receivedBytes: 2048, totalBytes: 4096 }); // 间隔内，被节流
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\[claude darwin-arm64\] 25% /);
  await new Promise((r) => setTimeout(r, 60));
  onProgress({ receivedBytes: 4096, totalBytes: 4096 });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /100% 0\.0\/0\.0MB/);
  finish(); // writeLine 注入模式下 no-op，不抛错即可
});

test('downloadToFileWithTimeout: 窗口未攒满前不评估吞吐（短小下载不误伤）', async () => {
  const dest = tmpPath('bin');
  // trickle-short 全程 ~250ms < 窗口 5s，即便均速远低于下限也不应触发。
  const { size } = await downloadToFileWithTimeout(`${base}/trickle-short`, dest, {}, {
    minThroughputBytesPerSec: 10_000,
    throughputWindowMs: 5_000,
    stallTimeoutMs: 10_000,
    totalTimeoutMs: 60_000,
  });
  assert.equal(size, 5);
});
