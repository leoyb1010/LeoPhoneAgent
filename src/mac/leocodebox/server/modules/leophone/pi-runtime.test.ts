import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EVENT_APPROVAL_REQUEST,
  EVENT_RUN_COMPLETED,
  EVENT_RUN_FAILED,
  EVENT_SESSION_COMPACTING,
  EVENT_SESSION_RETRYING,
  EVENT_TOOL_COMPLETED,
  EVENT_TOOL_DELTA,
  EVENT_TOOL_STARTED,
  PiRpcDialect,
} from './harness-dialects.js';
import { clipDenyReason, normalizePolicy, writeDenyReasonAt } from './pi-runtime.js';

// 2.0 内核的协议契约:pi RPC 的 extension_ui_request 必须变成一张各端都能
// 回答的审批卡,答复必须按 pi 真实协议回去(select → value,confirm → confirmed)。
// 旧实现读 choices / 回 result,与 docs/rpc.md 对不上 —— 审批永远送不回 pi。

const leoTitle = JSON.stringify({
  leo: 1, title: '要在 mbp 上执行', tool: 'bash', command: 'rm -rf dist', cwd: '/w', host: 'mbp', scope: 'abc', args: { command: 'rm -rf dist' },
});

test('select 请求 → approval.request,结构化字段与选项原样进卡', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({
    type: 'extension_ui_request', id: 'ui-1', method: 'select', title: leoTitle, options: ['once', 'session', 'deny'],
  });
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.event, EVENT_APPROVAL_REQUEST);
  assert.equal(ev.request_id, 'ui-1');
  assert.equal(ev.title, '要在 mbp 上执行');
  assert.equal(ev.command, 'rm -rf dist');
  assert.equal(ev.tool, 'bash');
  assert.equal(ev.cwd, '/w');
  assert.equal(ev.host, 'mbp');
  assert.deepEqual(ev.choices, ['once', 'session', 'deny']);
  assert.equal(ev.method, 'select');
});

test('普通 extension 的 select(非 leo 标题)也能进卡,标题即命令', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] });
  assert.equal(events[0].command, 'Allow?');
  assert.deepEqual(events[0].choices, ['Allow', 'Block']);
});

test('select 的答复按 pi 协议回 value;客户端词汇 always/deny 映射到选项', () => {
  const dialect = new PiRpcDialect();
  const pending = { request_id: 'ui-1', method: 'select', choices: ['once', 'session', 'deny'] };
  assert.deepEqual(dialect.approvalPayload(pending, 'session'), { id: 'ui-1', type: 'extension_ui_response', value: 'session' });
  assert.deepEqual(dialect.approvalPayload(pending, 'always'), { id: 'ui-1', type: 'extension_ui_response', value: 'once' });
  assert.deepEqual(dialect.approvalPayload(pending, 'deny'), { id: 'ui-1', type: 'extension_ui_response', value: 'deny' });
  const foreign = { request_id: 'ui-2', method: 'select', choices: ['Allow', 'Block'] };
  assert.deepEqual(dialect.approvalPayload(foreign, 'once'), { id: 'ui-2', type: 'extension_ui_response', value: 'Allow' });
  assert.deepEqual(dialect.approvalPayload(foreign, 'deny'), { id: 'ui-2', type: 'extension_ui_response', value: 'Block' });
});

test('confirm 的答复回 confirmed 布尔', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({ type: 'extension_ui_request', id: 'ui-3', method: 'confirm', title: 'Clear?', message: 'All gone' });
  assert.equal(events[0].method, 'confirm');
  assert.deepEqual(events[0].choices, ['once', 'deny']);
  assert.deepEqual(dialect.approvalPayload(events[0], 'once'), { id: 'ui-3', type: 'extension_ui_response', confirmed: true });
  assert.deepEqual(dialect.approvalPayload(events[0], 'deny'), { id: 'ui-3', type: 'extension_ui_response', confirmed: false });
});

test('缺 request_id 的 pending 不能伪装成已送达', () => {
  assert.equal(new PiRpcDialect().approvalPayload({ method: 'select', choices: ['once'] }, 'once'), null);
});

test('过载 willRetry / auto_retry 不把会话打成完成', () => {
  const dialect = new PiRpcDialect();
  const hold = dialect.translateLine({ type: 'agent_end', willRetry: true, attempt: 1, maxAttempts: 3, delayMs: 2000 }).events;
  assert.equal(hold[0]?.event, EVENT_SESSION_RETRYING);
  const start = dialect.translateLine({
    type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded',
  }).events;
  assert.equal(start[0]?.event, EVENT_SESSION_RETRYING);
  assert.equal(start[0]?.attempt, 1);
  assert.deepEqual(dialect.translateLine({ type: 'auto_retry_end', success: true, attempt: 2 }).events, []);
  const dead = dialect.translateLine({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' }).events;
  assert.equal(dead[0]?.event, EVENT_RUN_FAILED);
});

test('阈值压缩变成 session.compacting / session.compacted,不报完成', () => {
  const dialect = new PiRpcDialect();
  const start = dialect.translateLine({ type: 'compaction_start', reason: 'threshold' }).events;
  assert.equal(start[0]?.event, EVENT_SESSION_COMPACTING);
  const done = dialect.translateLine({
    type: 'compaction_end',
    reason: 'threshold',
    result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
    aborted: false,
    willRetry: false,
  }).events;
  assert.equal(done[0]?.event, 'session.compacted');
  assert.equal(done[0]?.tokensBefore, 150000);
  assert.equal(done[0]?.tokensAfter, 32000);
  assert.equal(done.some((event) => event.event === EVENT_RUN_COMPLETED), false);
  const aborted = dialect.translateLine({ type: 'compaction_end', reason: 'manual', aborted: true, result: null }).events;
  assert.equal(aborted[0]?.event, 'session.compacted');
  assert.equal(aborted[0]?.aborted, true);
  const dead = dialect.translateLine({
    type: 'compaction_end', reason: 'overflow', result: null, aborted: false, errorMessage: 'quota exceeded',
  }).events;
  assert.equal(dead[0]?.event, EVENT_RUN_FAILED);
});

test('agent_end 才算一次运行完成;turn_end 只是透传', () => {
  const dialect = new PiRpcDialect();
  assert.equal(dialect.translateLine({ type: 'turn_end' }).events[0].event, 'harness.turn_end');
  assert.equal(dialect.translateLine({ type: 'agent_end' }).events[0].event, EVENT_RUN_COMPLETED);
});

test('助手 stopReason=error 时 agent_end 是 run.failed,不是空白完成', () => {
  const dialect = new PiRpcDialect();
  dialect.translateLine({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: "Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    },
  });
  const { events } = dialect.translateLine({ type: 'agent_end' });
  assert.equal(events[0].event, EVENT_RUN_FAILED);
  assert.match(String(events[0].error), /ChatGPT account/);
  assert.equal(new PiRpcDialect().translateLine({ type: 'agent_end' }).events[0].event, EVENT_RUN_COMPLETED);
});

test('prompt 被 pi 拒绝(如没配密钥)→ run.failed,而不是永远 running', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({ type: 'response', command: 'prompt', success: false, error: 'No API key found for the selected model.' });
  assert.equal(events[0].event, 'run.failed');
  assert.match(String(events[0].error), /No API key/);
  assert.equal(dialect.translateLine({ type: 'response', command: 'prompt', success: true }).events[0].event, 'harness.response');
});

test('输入栏 $ 的 bash 增量叠成 live delta,回执闭合工具', () => {
  const dialect = new PiRpcDialect();
  const first = dialect.translateLine({ type: 'bash_execution_update', id: 'sh1', delta: 'PASS 1\n' }).events;
  assert.equal(first[0]?.event, EVENT_TOOL_DELTA);
  assert.equal(first[0]?.output, 'PASS 1\n');
  const more = `${'ok '.repeat(40)}\n`;
  const second = dialect.translateLine({ type: 'bash_execution_update', id: 'sh1', delta: more }).events;
  assert.equal(second[0]?.event, EVENT_TOOL_DELTA);
  assert.equal(String(second[0]?.output).startsWith('PASS 1\n'), true);
  const done = dialect.translateLine({
    type: 'response', command: 'bash', success: true, id: 'sh1',
    data: { output: 'PASS 1\nPASS 2\n', exitCode: 0 },
  }).events;
  assert.equal(done[0]?.event, EVENT_TOOL_COMPLETED);
  assert.equal(done[0]?.error, false);
  assert.equal(done[0]?.output, 'PASS 1\nPASS 2\n');
});

test('非文本的 message_update 不进日志;工具输出流只发 live delta;文本增量照常', () => {
  const dialect = new PiRpcDialect();
  assert.deepEqual(dialect.translateLine({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } }).events, []);
  const live = dialect.translateLine({ type: 'tool_execution_update', toolCallId: 'tc1', partialResult: 'PASS 3\n' }).events;
  assert.equal(live[0]?.event, EVENT_TOOL_DELTA);
  assert.equal(live[0]?.output, 'PASS 3\n');
  assert.deepEqual(dialect.translateLine({ type: 'tool_execution_update', toolCallId: 'tc1', partialResult: 'PASS 3\n' }).events, []);
  assert.equal(dialect.translateLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好' } }).events[0].event, 'message.delta');
});

test('工具开始事件带 tool_use_id 与人类可读预览', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'npm test' } });
  assert.equal(events[0].event, EVENT_TOOL_STARTED);
  assert.equal(events[0].tool_use_id, 'tc1');
  assert.equal(events[0].preview, 'npm test');
});

test('审批策略的五种叫法统一成四种,认不出来回落到 default', () => {
  assert.equal(normalizePolicy('默认审批'), 'default');
  assert.equal(normalizePolicy('acceptEdits'), 'accept_edits');
  assert.equal(normalizePolicy('接受编辑'), 'accept_edits');
  assert.equal(normalizePolicy('计划模式'), 'plan');
  assert.equal(normalizePolicy('bypassPermissions'), 'auto');
  assert.equal(normalizePolicy('跳过审批'), 'auto');
  assert.equal(normalizePolicy('whatever'), 'default');
  assert.equal(normalizePolicy(undefined), 'default');
});

test('拒绝的为什么会写到策略旁边，extension 会去读', () => {
  const src = readFileSync(fileURLToPath(new URL('./pi-runtime.ts', import.meta.url)), 'utf8');
  assert.match(src, /file \+ "\.deny"/);
  assert.equal(clipDenyReason('  不要删  '), '不要删');
});

test('拒绝理由落盘，空的会清掉', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-deny-'));
  const policy = path.join(dir, 'hs_1.json');
  await fs.writeFile(policy, '{}');
  const dest = writeDenyReasonAt(policy, '不要删，改挪走');
  assert.equal(await fs.readFile(dest, 'utf8'), '不要删，改挪走');
  assert.equal(writeDenyReasonAt(policy, '  '), '');
  await assert.rejects(() => fs.readFile(dest, 'utf8'));
  await fs.rm(dir, { recursive: true, force: true });
});
