// One-shot CDP injector for renderer JS during Phase 6 E2E.
// Usage:
//   node cdp-eval.mjs eval <expression-file>
//   node cdp-eval.mjs screenshot <out-png-path>
// Connects to Electron renderer at port 9222, runs Runtime.evaluate or Page.captureScreenshot.

import WebSocket from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = 9222;
const cmd = process.argv[2];
const arg = process.argv[3];
if (!cmd || !arg) {
  console.error('usage: cdp-eval.mjs eval <expr.js> | screenshot <out.png>');
  process.exit(2);
}

async function main() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const target = list.find(t => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
  if (!target) { console.error('renderer page target not found'); process.exit(3); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.on('error', (e) => { console.error('ws error', e.message); process.exit(4); });
  setTimeout(() => { console.error('timeout'); process.exit(5); }, 60000);

  await new Promise(res => ws.on('open', res));

  if (cmd === 'eval') {
    const expression = readFileSync(arg, 'utf8');
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) {
        console.log(JSON.stringify(m.result, null, 2));
        ws.close(); process.exit(0);
      }
    });
  } else if (cmd === 'screenshot') {
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) {
        if (m.error) { console.error('cdp error', m.error); process.exit(6); }
        const buf = Buffer.from(m.result.data, 'base64');
        writeFileSync(arg, buf);
        console.log('screenshot saved:', arg, 'bytes', buf.length);
        ws.close(); process.exit(0);
      }
    });
  } else {
    console.error('unknown cmd', cmd); process.exit(2);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
