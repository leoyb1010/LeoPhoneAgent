#!/usr/bin/env node
// 本地 mock 的 Telegram Bot API:不需要真 bot,就能把「Telegram 说话 → 开会话 → 审批卡 →
// 点按钮 → 回执」整条链跑通。控制面:POST /_push 注入 update,GET /_sent 读机器人发出的消息。
//
// 用法: node scripts/mock-telegram-server.mjs [port=39997]
import http from 'node:http';

const port = Number(process.argv[2] || 39997);
const pending = [];           // 待 getUpdates 取走的 update
const sent = [];              // 机器人发出的消息 / 编辑 / 回调应答
let updateId = 1000;
let messageId = 1;
const waiters = [];

function json(res, obj) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'POST' && url.pathname === '/_push') {
    const body = await readBody(req);
    const update = { update_id: updateId++, ...body };
    pending.push(update);
    const w = waiters.shift(); if (w) w();
    json(res, { ok: true, update_id: update.update_id });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/_sent') { json(res, sent); return; }
  if (req.method === 'POST' && url.pathname === '/_reset') { sent.length = 0; pending.length = 0; json(res, { ok: true }); return; }
  const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
  if (!m) { res.writeHead(404); res.end('not found'); return; }
  const method = m[2];
  const body = await readBody(req);
  if (method === 'getMe') { json(res, { ok: true, result: { id: 1, is_bot: true, username: 'leo_mock_bot' } }); return; }
  if (method === 'getUpdates') {
    const deliver = () => { const batch = pending.splice(0); json(res, { ok: true, result: batch }); };
    if (pending.length > 0) { deliver(); return; }
    const timer = setTimeout(() => { const i = waiters.indexOf(wake); if (i >= 0) waiters.splice(i, 1); deliver(); }, Math.min(Number(body.timeout || 0), 5) * 1000);
    const wake = () => { clearTimeout(timer); deliver(); };
    waiters.push(wake);
    return;
  }
  if (method === 'sendMessage') { const id = messageId++; sent.push({ method, message_id: id, ...body }); json(res, { ok: true, result: { message_id: id, chat: { id: body.chat_id }, text: body.text } }); return; }
  if (method === 'editMessageText' || method === 'answerCallbackQuery') { sent.push({ method, ...body }); json(res, { ok: true, result: true }); return; }
  json(res, { ok: true, result: {} });
}).listen(port, '127.0.0.1', () => process.stdout.write(`mock-telegram listening on http://127.0.0.1:${port}\n`));
