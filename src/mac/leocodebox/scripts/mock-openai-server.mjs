#!/usr/bin/env node
// 本地 mock 的 OpenAI 兼容模型服务:不需要任何真实密钥,就能让 pi 运行时
// 走完「模型要求调用 bash → 审批 → 执行 → 模型收到结果 → 收尾」整条链。
// 给 pi-runtime 的端到端测试用;也可以手动起来配合 --provider mock 调试。
//
// 用法: node scripts/mock-openai-server.mjs [port=39998] [command="ls"]
import http from 'node:http';

const port = Number(process.argv[2] || 39998);
const toolCommand = process.argv[3] || 'ls';

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function chunk(id, delta, finish = null) {
  return { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-1',
    choices: [{ index: 0, delta, finish_reason: finish }] };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    // 只看最后一条:用户刚说话 → 要求跑工具;工具结果刚回来 → 收尾。
    // (不能看"历史里有没有工具结果",否则第二轮起永远直接收尾,审批链测不到。)
    const lastMessage = messages[messages.length - 1] || {};
    const sawToolResult = lastMessage.role === 'tool';
    const id = `chatcmpl-${Date.now()}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!sawToolResult) {
      // 第一轮:要求执行一条 bash
      sse(res, chunk(id, { role: 'assistant', content: '' }));
      sse(res, chunk(id, { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'bash', arguments: '' } }] }));
      sse(res, chunk(id, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: toolCommand }) } }] }));
      sse(res, chunk(id, {}, 'tool_calls'));
    } else {
      // 第二轮:收到工具结果,收尾
      for (const piece of ['已经', '执行完了', ',结果在上面。']) sse(res, chunk(id, { content: piece }));
      sse(res, chunk(id, {}, 'stop'));
    }
    sse(res, { id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-openai listening on http://127.0.0.1:${port}/v1 (tool command: ${toolCommand})\n`);
});
