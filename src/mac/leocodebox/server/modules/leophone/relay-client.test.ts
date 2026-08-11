import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { LeophoneRelayClient } from './relay-client.service.js';

// 帧协议与 relay.py 对偶:register → http/resp、stream_open/stream_data/
// stream_close/stream_cancel。这里立一个假中继 + 一个假本机 leophone,
// 验证客户端把中继帧正确翻成带鉴权的本机调用并回帧。

const LOCAL_KEY = 'test-key-0123456789abcdef';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function startFakeLocal(): Promise<{ port: number; close: () => void; seen: Array<{ path: string; auth: string | undefined }> }> {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url || '', auth: req.headers.authorization });
    if (req.url?.includes('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"seq":1}\n\n');
      res.write(': keep-alive\n\n');
      res.write('data: {"seq":2}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echoedPath: req.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => server.close(),
        seen,
      });
    });
  });
}

test('relay client: registers, forwards http frames to /leophone with Bearer key, relays streams', async () => {
  const local = await startFakeLocal();

  const frames: Array<Record<string, unknown>> = [];
  let agentSocket: WsSocket | null = null;
  const registered = deferred<Record<string, unknown>>();
  const gotResp = deferred<Record<string, unknown>>();
  const streamFrames: Array<Record<string, unknown>> = [];
  const streamClosed = deferred<void>();

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket) => {
    agentSocket = socket;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === 'register') {
        registered.resolve(frame);
        socket.send(JSON.stringify({ type: 'registered' }));
      } else if (frame.type === 'resp') {
        gotResp.resolve(frame);
      } else if (frame.type === 'stream_data') {
        streamFrames.push(frame);
      } else if (frame.type === 'stream_close') {
        streamClosed.resolve();
      }
    });
  });
  await new Promise((resolve) => wss.on('listening', resolve));
  const relayPort = (wss.address() as AddressInfo).port;

  const client = new LeophoneRelayClient({
    wsUrl: `ws://127.0.0.1:${relayPort}/relay/agent`,
    relayKey: 'relay-key-0123456789abcdef',
    localKey: LOCAL_KEY,
    name: 'test-mac',
  }, local.port);

  const run = client.runOnce();

  const registerFrame = await registered.promise;
  assert.equal(registerFrame.name, 'test-mac');
  assert.equal(registerFrame.key, 'relay-key-0123456789abcdef');

  // 一问一答
  agentSocket!.send(JSON.stringify({
    type: 'http', id: 'r1', method: 'GET', path: '/harness/sessions',
  }));
  const resp = await gotResp.promise;
  assert.equal(resp.id, 'r1');
  assert.equal(resp.status, 200);
  assert.equal((resp.body as Record<string, unknown>).echoedPath, '/leophone/harness/sessions');

  // 事件流:data 帧透传(剥 SSE 前缀),注释保活被丢弃,结束回 stream_close
  agentSocket!.send(JSON.stringify({
    type: 'stream_open', id: 's1', path: '/harness/sessions/hs_x/events?after=0',
  }));
  await streamClosed.promise;
  assert.deepEqual(streamFrames.map((frame) => frame.data), ['{"seq":1}', '{"seq":2}']);

  // 本机调用必须带 harness Bearer key,且路径带 /leophone 前缀
  assert.ok(local.seen.every((entry) => entry.auth === `Bearer ${LOCAL_KEY}`));
  assert.ok(local.seen.every((entry) => entry.path.startsWith('/leophone/')));

  agentSocket!.close();
  await run.catch(() => { /* 断开按重连处理,测试里忽略 */ });
  wss.close();
  local.close();
});
