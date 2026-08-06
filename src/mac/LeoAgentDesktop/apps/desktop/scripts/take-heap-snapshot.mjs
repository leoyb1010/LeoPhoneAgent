#!/usr/bin/env node
// Take a V8 heap snapshot from a running xdt-maker dev Electron renderer via CDP.
//
// Prereq: dev electron must have been started with --remote-debugging-port=9222.
// bootstrap-electron.ts appends that switch automatically in `!app.isPackaged`,
// so any `pnpm restart:desktop:remote` run picks it up.
//
// Usage:
//   node apps/desktop/scripts/take-heap-snapshot.mjs                    # auto: biggest renderer
//   node apps/desktop/scripts/take-heap-snapshot.mjs --target main      # main window
//   node apps/desktop/scripts/take-heap-snapshot.mjs --target-id <id>   # specific CDP target id
//   node apps/desktop/scripts/take-heap-snapshot.mjs --list             # just list targets
//   node apps/desktop/scripts/take-heap-snapshot.mjs --out <path>       # custom output file
//   node apps/desktop/scripts/take-heap-snapshot.mjs --port 9222        # custom CDP port
//
// Output: apps/desktop/logs/heap-<timestamp>.heapsnapshot (gzipped JSON, openable in DevTools)
//
// Why not just open DevTools manually: a 13 GB renderer often can't open DevTools
// without OOM. CDP path keeps the renderer untouched and writes chunks straight to disk.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Native WebSocket landed stable in Node 22. xdt-maker requires Node 22+.
const WS = globalThis.WebSocket;
if (!WS) {
  console.error('FATAL: globalThis.WebSocket missing. Need Node 22+.');
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 9222);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.resolve(HERE, '..', 'logs');

main().catch((err) => {
  console.error('FAIL:', err?.stack || err?.message || err);
  process.exit(1);
});

async function main() {
  const targets = await fetchTargets(PORT);
  const pageTargets = targets.filter((t) => t.type === 'page');

  if (args.list) {
    printTargetList(targets);
    return;
  }

  if (pageTargets.length === 0) {
    console.error(`No 'page' targets on http://127.0.0.1:${PORT}. All targets:`);
    printTargetList(targets);
    process.exit(3);
  }

  const target = await pickTarget(pageTargets);
  console.log(`[snapshot] target: id=${target.id} title="${target.title}" url=${target.url}`);
  console.log(`[snapshot]         ws=${target.webSocketDebuggerUrl}`);

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(DEFAULT_OUT_DIR, `heap-${tsStamp()}.heapsnapshot`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  console.log(`[snapshot] writing to: ${outPath}`);

  const bytes = await takeSnapshot(target.webSocketDebuggerUrl, outPath);
  console.log(`[snapshot] done. ${bytes} bytes written.`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--target-id') out.targetId = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(readSelfDocstring());
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(64);
    }
  }
  return out;
}

function readSelfDocstring() {
  // First leading // block of this file
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = self.split('\n');
  const out = [];
  for (const l of lines) {
    if (l.startsWith('//') || l.startsWith('#!')) out.push(l);
    else if (out.length > 0) break;
  }
  return out.join('\n');
}

function fetchTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: 3000 },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from /json/list`));
          res.resume();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', (e) => reject(
      new Error(
        `Cannot reach CDP on 127.0.0.1:${port}. Is dev electron running with ` +
        `--remote-debugging-port=${port}? (${e.message})`,
      ),
    ));
    req.on('timeout', () => {
      req.destroy(new Error('CDP /json/list timed out'));
    });
  });
}

function printTargetList(targets) {
  for (const t of targets) {
    console.log(`  - [${t.type}] id=${t.id} title="${t.title}" url=${t.url}`);
  }
}

async function pickTarget(pageTargets) {
  if (args.targetId) {
    const t = pageTargets.find((x) => x.id === args.targetId);
    if (!t) throw new Error(`no target with id=${args.targetId}`);
    return t;
  }
  if (args.target === 'main') {
    // Heuristic: main window is usually the first page target (renderer-client-id=4).
    return pageTargets[0];
  }
  if (pageTargets.length === 1) return pageTargets[0];

  // Auto: probe each via a quick Runtime.evaluate of process.memoryUsage().heapUsed
  // and pick the biggest. Skip targets where eval fails (e.g. about:blank).
  console.log(`[snapshot] probing ${pageTargets.length} renderer targets for heap size...`);
  let best = null;
  let bestHeap = -1;
  for (const t of pageTargets) {
    const heap = await probeRendererHeap(t.webSocketDebuggerUrl).catch(() => -1);
    console.log(`           id=${t.id} heapUsed=${heap < 0 ? 'unknown' : `${(heap / 1024 / 1024).toFixed(1)} MB`} title="${t.title}"`);
    if (heap > bestHeap) {
      best = t;
      bestHeap = heap;
    }
  }
  if (!best) throw new Error('no renderer responded to probe');
  return best;
}

function probeRendererHeap(wsUrl) {
  // For Electron renderers, process.memoryUsage() exists if nodeIntegration is on.
  // Otherwise fall back to performance.memory.usedJSHeapSize (chromium-only).
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    let msgId = 0;
    const send = (method, params) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('probe timeout'));
    }, 5000);
    ws.addEventListener('open', () => {
      send('Runtime.evaluate', {
        expression: `(()=>{try{return process.memoryUsage().heapUsed}catch{}; try{return performance.memory.usedJSHeapSize}catch{}; return -1})()`,
        returnByValue: true,
      });
    });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        clearTimeout(timer);
        ws.close();
        const v = m.result?.result?.value;
        resolve(typeof v === 'number' ? v : -1);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    });
  });
}

function takeSnapshot(wsUrl, outPath) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    const fd = fs.openSync(outPath, 'w');
    let bytes = 0;
    let msgId = 0;
    let snapshotMsgId = 0;
    let lastProgressLog = 0;

    const send = (method, params) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };

    const cleanup = (err) => {
      try { ws.close(); } catch { /* ignore */ }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(bytes);
    };

    ws.addEventListener('open', () => {
      send('HeapProfiler.enable', {});
      snapshotMsgId = send('HeapProfiler.takeHeapSnapshot', {
        reportProgress: true,
        // captureNumericValue=false keeps size down; we want object retainer tree anyway
        captureNumericValue: false,
      });
    });

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.method === 'HeapProfiler.addHeapSnapshotChunk') {
        const chunk = m.params?.chunk ?? '';
        const buf = Buffer.from(chunk, 'utf8');
        fs.writeSync(fd, buf, 0, buf.length);
        bytes += buf.length;
        return;
      }
      if (m.method === 'HeapProfiler.reportHeapSnapshotProgress') {
        const { done, total, finished } = m.params ?? {};
        const now = Date.now();
        if (finished || now - lastProgressLog > 500) {
          lastProgressLog = now;
          const pct = total ? ((done / total) * 100).toFixed(1) : '?';
          process.stderr.write(`\r[snapshot] progress: ${done}/${total} (${pct}%)${finished ? ' DONE' : ''}    `);
          if (finished) process.stderr.write('\n');
        }
        return;
      }
      if (m.id === snapshotMsgId) {
        if (m.error) {
          cleanup(new Error(`takeHeapSnapshot error: ${JSON.stringify(m.error)}`));
        } else {
          cleanup(null);
        }
      }
    });

    ws.addEventListener('error', () => cleanup(new Error('ws error during snapshot')));
    ws.addEventListener('close', () => {
      if (bytes === 0) cleanup(new Error('ws closed before any chunks received'));
    });
  });
}

function tsStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
