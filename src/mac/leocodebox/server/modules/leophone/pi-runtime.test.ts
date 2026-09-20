import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENT_APPROVAL_REQUEST,
  EVENT_RUN_COMPLETED,
  EVENT_RUN_FAILED,
  EVENT_TOOL_STARTED,
  PiRpcDialect,
} from './harness-dialects.js';
import { normalizePolicy } from './pi-runtime.js';

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

test('非文本的 message_update / 工具输出流不进日志;文本增量照常', () => {
  const dialect = new PiRpcDialect();
  assert.deepEqual(dialect.translateLine({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } }).events, []);
  assert.deepEqual(dialect.translateLine({ type: 'tool_execution_update', toolCallId: 'tc1', partialResult: 'x' }).events, []);
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
