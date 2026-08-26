import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ClaudeStreamJsonDialect,
  CodexAppServerDialect,
  GrokAcpDialect,
  PiRpcDialect,
} from './harness-dialects.js';
import { buildDigest, buildReceipt, isTerminal } from './harness-digest.service.js';
import { listArtifacts, readArtifact } from './harness-artifacts.service.js';
import { HarnessManager, HarnessSession, isLiveHarnessStatus } from './harness-session.service.js';
import { buildRemoteCreateBody, parseEventsAfter } from './fleet.routes.js';
import { HARNESSES, type HarnessSpec } from './harness-specs.js';
import { resumeEnvelope } from './resume-envelope.js';

// 协议保真是本模块的全部意义:手机端(LeoAgentHarness.swift)按字段名
// 渲染,这里的断言以 leoagent(Python harness.py)的输出为准。

const FAKE_SPEC: HarnessSpec = {
  key: 'claude', displayName: 'Claude Code', executable: 'claude',
  args: [], dialect: 'claude_stream_json',
};

test('cursor harness uses the official one-shot stream-json contract', () => {
  assert.deepEqual(HARNESSES.cursor.args, ['-p', '{prompt}', '--output-format', 'stream-json']);
  assert.equal(HARNESSES.cursor.executable, 'cursor-agent');
  assert.equal(HARNESSES.cursor.promptInArgs, true);
});

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-test-'));
  return path.join(dir, 'hs_test.ndjson');
}

// --------------------------------------------------------------------------
// Claude stream-json 方言
// --------------------------------------------------------------------------

test('claude dialect: assistant text/thinking/tool_use → vocabulary events', () => {
  const dialect = new ClaudeStreamJsonDialect();
  const { events } = dialect.translateLine({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
    ] },
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { event: 'message.delta', delta: 'hello' });
  assert.deepEqual(events[1], { event: 'reasoning.available', text: 'hmm' });
  assert.equal(events[2].event, 'tool.started');
  assert.equal(events[2].tool, 'Bash');
  assert.equal(events[2].tool_use_id, 'tu_1');
});

test('claude dialect: control_request can_use_tool → approval.request; result → run.completed', () => {
  const dialect = new ClaudeStreamJsonDialect();
  const approval = dialect.translateLine({
    type: 'control_request', request_id: 'req_9',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } },
  }).events;
  assert.equal(approval.length, 1);
  assert.equal(approval[0].event, 'approval.request');
  assert.equal(approval[0].command, 'Bash');
  assert.deepEqual(approval[0].choices, ['once', 'always', 'deny']);
  assert.equal(approval[0].request_id, 'req_9');

  const done = dialect.translateLine({ type: 'result', is_error: false, result: 'ok', usage: { input_tokens: 1 } }).events;
  assert.equal(done[0].event, 'run.completed');
  assert.equal(done[0].output, 'ok');

  // 其他 control_request 子类型必须原样透传,不得当审批处理。
  const passthrough = dialect.translateLine({
    type: 'control_request', request_id: 'req_10', request: { subtype: 'hook_callback' },
  }).events;
  assert.equal(passthrough[0].event, 'harness.control_request');
});

test('claude dialect: approval payload uses control_response envelope; deny carries message', () => {
  const dialect = new ClaudeStreamJsonDialect();
  const allow = dialect.approvalPayload({ request_id: 'r1', raw: {} }, 'once') as Record<string, any>;
  assert.equal(allow.type, 'control_response');
  assert.equal(allow.response.request_id, 'r1');
  assert.deepEqual(allow.response.response, { behavior: 'allow' });

  const deny = dialect.approvalPayload({ request_id: 'r1', raw: {} }, 'deny') as Record<string, any>;
  assert.deepEqual(deny.response.response, { behavior: 'deny', message: 'denied by operator' });

  // 铸造 id(无 request_id)不可路由 → null,审批必须保持 pending。
  assert.equal(dialect.approvalPayload({ raw: {} }, 'once'), null);
});

// --------------------------------------------------------------------------
// codex app-server 方言
// --------------------------------------------------------------------------

test('codex dialect: handshake → initialize + thread/start; queued input flushes on threadId', () => {
  const dialect = new CodexAppServerDialect('/tmp/project');
  const frames = dialect.handshake() as Array<Record<string, any>>;
  assert.equal(frames[0].method, 'initialize');
  assert.equal(frames[1].method, 'thread/start');
  assert.equal(frames[1].params.cwd, '/tmp/project');

  // threadId 未就绪:输入排队
  assert.deepEqual(dialect.userMessage('do it'), { queued: true });

  // thread/started 通知到达 → 排队输入变成待写帧
  const { outFrames } = dialect.translateLine({ method: 'thread/started', params: { threadId: 't_1' } });
  assert.equal(outFrames.length, 1);
  const turn = outFrames[0] as Record<string, any>;
  assert.equal(turn.method, 'turn/start');
  assert.equal(turn.params.threadId, 't_1');
  assert.equal(turn.params.input[0].text, 'do it');

  // 就绪后直接给帧
  const direct = dialect.userMessage('more');
  assert.ok('frames' in direct && direct.frames.length === 1);
});

test('codex dialect: approval request/response and unsupported server request rejection', () => {
  const dialect = new CodexAppServerDialect('/tmp');
  const { events } = dialect.translateLine({
    id: 55, method: 'item/commandExecution/requestApproval',
    params: { item: { command: 'npm i' }, reason: 'install' },
  });
  assert.equal(events[0].event, 'approval.request');
  assert.equal(events[0].command, 'npm i');
  assert.equal(events[0].request_id, 55);

  const payload = dialect.approvalPayload({ request_id: 55 }, 'always') as Record<string, any>;
  assert.deepEqual(payload, { jsonrpc: '2.0', id: 55, result: { decision: 'acceptForSession' } });

  const rejected = dialect.translateLine({ id: 56, method: 'something/else', params: {} });
  assert.equal((rejected.outFrames[0] as Record<string, any>).error.code, -32601);
});

test('codex dialect: item notifications → tool/message events; turn/completed → run.completed', () => {
  const dialect = new CodexAppServerDialect('/tmp');
  const started = dialect.translateLine({
    method: 'item/started', params: { item: { type: 'commandExecution', id: 'i1', command: 'ls -la' } },
  }).events;
  assert.equal(started[0].event, 'tool.started');
  assert.equal(started[0].preview, 'ls -la');

  const completed = dialect.translateLine({
    method: 'item/completed', params: { item: { type: 'commandExecution', id: 'i1', exitCode: 0 } },
  }).events;
  assert.equal(completed[0].event, 'tool.completed');
  assert.equal(completed[0].error, false);

  const message = dialect.translateLine({
    method: 'item/completed', params: { item: { type: 'agentMessage', id: 'i2', text: 'done' } },
  }).events;
  assert.deepEqual(message[0], { event: 'message.delta', delta: 'done' });

  const turn = dialect.translateLine({ method: 'turn/completed', params: {} }).events;
  assert.equal(turn[0].event, 'run.completed');
});

// --------------------------------------------------------------------------
// grok ACP 方言
// --------------------------------------------------------------------------

test('grok dialect: session capture, prompt lifecycle, permission options', () => {
  const dialect = new GrokAcpDialect('/tmp');
  dialect.handshake();
  assert.deepEqual(dialect.userMessage('hi'), { queued: true });

  // session/new 响应带 sessionId → 排队输入补发,prompt id 被记录
  const { outFrames } = dialect.translateLine({ id: 102, result: { sessionId: 's_1' } });
  assert.equal(outFrames.length, 1);
  const prompt = outFrames[0] as Record<string, any>;
  assert.equal(prompt.method, 'session/prompt');
  assert.equal(prompt.params.sessionId, 's_1');

  // 该 prompt 的响应到达 → run.completed
  const done = dialect.translateLine({ id: prompt.id, result: {} }).events;
  assert.equal(done[0].event, 'run.completed');

  // 流式更新
  const chunk = dialect.translateLine({
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hey' } } },
  }).events;
  assert.deepEqual(chunk[0], { event: 'message.delta', delta: 'hey' });

  // 审批:按 kind 选 optionId;找不到语义匹配时退回 reject,绝不误放行
  const approval = dialect.translateLine({
    id: 200, method: 'session/request_permission',
    params: { toolCall: { title: 'run ls' }, options: [
      { optionId: 'o1', kind: 'allow_once' }, { optionId: 'o2', kind: 'reject_once' },
    ] },
  }).events[0];
  const allow = dialect.approvalPayload(approval, 'once') as Record<string, any>;
  assert.equal(allow.result.outcome.optionId, 'o1');
  const deny = dialect.approvalPayload(approval, 'deny') as Record<string, any>;
  assert.equal(deny.result.outcome.optionId, 'o2');
  const noOptions = dialect.approvalPayload({ request_id: 200, raw: { options: [] } }, 'once');
  assert.equal(noOptions, null);
});

// --------------------------------------------------------------------------
// pi 方言(抽查)
// --------------------------------------------------------------------------

test('pi dialect: deltas and select approval round-trip', () => {
  const dialect = new PiRpcDialect();
  const delta = dialect.translateLine({
    type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' },
  }).events;
  assert.deepEqual(delta[0], { event: 'message.delta', delta: 'x' });

  const approval = dialect.translateLine({
    type: 'extension_ui_request', method: 'select', id: 'ui1',
    message: '选一个', choices: ['继续', '放弃'],
  }).events[0];
  assert.deepEqual(approval.choices, ['继续', '放弃']);
  // CLI 自带标签原样返回
  const chosen = dialect.approvalPayload(approval, '继续') as Record<string, any>;
  assert.equal(chosen.result, '继续');
});

// --------------------------------------------------------------------------
// 会话日志:先写后扇出、seq 单调、approval_id 铸造、回放去重
// --------------------------------------------------------------------------

test('session journal: enrichment lands in the log; replay(after) is exact', () => {
  const session = new HarnessSession({
    sessionId: 'hs_t1', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'session.created', harness: 'claude', name: 'Claude Code', cwd: '/tmp' });
  session.emit({ event: 'tool.started', tool: 'Bash', preview: 'ls', tool_use_id: 'tu1' });
  // 完成事件不带名字 → 从 started 事件继承,客户端靠它闭合运行中的卡片
  session.emit({ event: 'tool.completed', tool: 'tool', error: false, tool_use_id: 'tu1' });
  session.emit({ event: 'approval.request', command: 'Bash', description: '', choices: ['once', 'deny'], raw: {} });

  const all = session.replay(0);
  assert.deepEqual(all.map((event) => event.seq), [1, 2, 3, 4]);
  assert.equal(all[2].tool, 'Bash');
  // CLI 没给 request_id → 铸造的 approval_id 必须已经在日志里(先富化后写盘)
  const minted = all[3].approval_id;
  assert.ok(typeof minted === 'string' && minted.startsWith('ap_'));
  assert.equal(session.status, 'waiting_for_approval');
  assert.ok(session.pendingApprovals.has(minted));

  // 断线续传:只要 seq > after 的
  assert.deepEqual(session.replay(2).map((event) => event.seq), [3, 4]);
});

test('session subscribe: replay-then-follow without gap or repeat; terminal event ends stream', async () => {
  const session = new HarnessSession({
    sessionId: 'hs_t2', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'message.delta', delta: 'a' });
  session.emit({ event: 'message.delta', delta: 'b' });

  const seen: number[] = [];
  const consumer = (async () => {
    for await (const event of session.subscribe(1)) {
      seen.push(Number(event.seq));
    }
  })();

  // 让回放先跑完,再产生实时事件
  await new Promise((resolve) => setTimeout(resolve, 20));
  session.emit({ event: 'message.delta', delta: 'c' });
  session.status = 'cancelled';
  session.emit({ event: 'run.cancelled' });
  await consumer;

  // after=1 → 回放 2,实时 3、4(run.cancelled)后流结束
  assert.deepEqual(seen, [2, 3, 4]);
});

test('stop emits run.cancelled immediately and rejects later steer', async () => {
  const session = new HarnessSession({
    sessionId: 'hs_stop', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'session.created', harness: 'claude', name: 'Claude Code', cwd: '/tmp' });
  session.status = 'running';

  const seen: string[] = [];
  const consumer = (async () => {
    for await (const event of session.subscribe(0)) {
      seen.push(String(event.event));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.stop();
  await consumer;

  assert.equal(session.status, 'cancelled');
  assert.ok(seen.includes('run.cancelled'));
  assert.equal(isLiveHarnessStatus(session.status), false);
  await assert.rejects(() => session.send('steer after stop'), /not running/);
  // 二次 stop 必须幂等,不能再写一条 cancelled
  await session.stop();
  assert.equal(session.replay(0).filter((event) => event.event === 'run.cancelled').length, 1);
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 会话跑的 CLI 会自己拉起 `npm test` / dev server 这类长命子进程。只杀组长的话
// 它们会被 init 收养后继续跑(还继续占端口),而会话状态已经写成 cancelled ——
// 用户点了停止,机器上却什么都没停。spawn 的 detached + stop 的 killpg 是这条
// 保证的两半,少一半都不成立。
test('stop takes down the whole process group, not just the CLI itself',
  { skip: process.platform === 'win32' }, async () => {
    const spec: HarnessSpec = {
      key: 'claude', displayName: 'shell stand-in', executable: 'sh',
      // 孙子进程的 stdout 指向 /dev/null,免得它一直握着 pump 的那根管子。
      args: ['-c', 'sleep 30 >/dev/null 2>&1 & echo GRANDCHILD $!; sleep 30'],
      dialect: 'claude_stream_json',
    };
    const session = new HarnessSession({
      sessionId: 'hs_pgroup', spec, cwd: os.tmpdir(), logPath: tempLog(),
    });
    await session.start();

    let grandchildPid = 0;
    for (let attempt = 0; attempt < 100 && !grandchildPid; attempt += 1) {
      for (const event of session.replay(0)) {
        const text = String(event.text ?? '');
        const match = /^GRANDCHILD (\d+)$/.exec(text.trim());
        if (match) grandchildPid = Number(match[1]);
      }
      if (!grandchildPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(grandchildPid > 1, 'stand-in CLI never reported its grandchild pid');
    assert.equal(pidAlive(grandchildPid), true);

    await session.stop();
    assert.equal(session.status, 'cancelled');
    assert.equal(pidAlive(grandchildPid), false);
  });

test('stop on an already-completed session does not rewrite the outcome', async () => {
  const session = new HarnessSession({
    sessionId: 'hs_done', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.status = 'completed';
  session.emit({ event: 'run.completed', output: 'ok', usage: {} });
  await session.stop();
  assert.equal(session.status, 'completed');
  assert.equal(session.replay(0).some((event) => event.event === 'run.cancelled'), false);
});

test('fleet helpers: after=N and minis create body drop Mac cwd', () => {
  assert.equal(parseEventsAfter('7'), 7);
  assert.equal(parseEventsAfter('-1'), 0);
  assert.equal(parseEventsAfter('nope'), 0);
  assert.deepEqual(
    buildRemoteCreateBody({ harness: 'minis', cwd: '/Users/leo/proj', thinking: 'high' }, 'go'),
    { harness: 'minis', prompt: 'go', thinking: 'high' },
  );
  assert.deepEqual(
    buildRemoteCreateBody({ harness: 'claude', cwd: '/tmp/proj' }, 'go'),
    { harness: 'claude', prompt: 'go', cwd: '/tmp/proj' },
  );
});

test('manager rehydrate: previous-boot logs surface as orphaned sessions with exact seq', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-rehydrate-'));
  const lines = [
    { event: 'session.created', harness: 'codex', name: 'Codex CLI', cwd: '/tmp/x', seq: 1, session_id: 'hs_old', timestamp: 1 },
    { event: 'message.delta', delta: 'hi', seq: 2, session_id: 'hs_old', timestamp: 2 },
  ];
  fs.writeFileSync(path.join(dir, 'hs_old.ndjson'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const manager = new HarnessManager(dir);
  const rehydrated = manager.get('hs_old');
  assert.ok(rehydrated);
  assert.equal(rehydrated.status, 'orphaned');
  assert.equal(rehydrated.seq, 2);
  assert.equal(rehydrated.cwd, '/tmp/x');
  assert.equal(rehydrated.spec.key, 'codex');
  // 召回的会话只读:send 必须给出可行动的失败
  return rehydrated.send('x').then(
    () => assert.fail('send on orphaned session must reject'),
    (error: Error) => assert.match(error.message, /not running/),
  );
});

// --------------------------------------------------------------------------
// [T-leophone-digest] 摘要 / 收据 / 产物
// --------------------------------------------------------------------------

test('digest: 把事件日志折叠成结构化摘要', () => {
  const session = new HarnessSession({
    sessionId: 'hs_dg1', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'session.created', harness: 'claude', name: 'Claude Code', cwd: '/tmp' });
  session.emit({ event: 'user.message', text: '把测试跑一遍' });
  session.emit({ event: 'tool.started', tool: 'Bash', preview: 'npm test src/app.ts', tool_use_id: 'tu1' });
  session.emit({ event: 'tool.completed', tool: 'Bash', error: false, tool_use_id: 'tu1' });
  session.emit({ event: 'message.delta', delta: '测试' });
  session.emit({ event: 'message.delta', delta: '通过了' });
  session.emit({ event: 'run.completed', output: '', usage: {} });

  const digest = buildDigest(session);
  assert.equal(digest.session_id, 'hs_dg1');
  assert.deepEqual(digest.prompts, ['把测试跑一遍']);
  assert.equal(digest.tools.length, 1);
  assert.equal(digest.tools[0].ok, true);
  assert.equal(digest.last_message, '测试通过了');
  assert.equal(digest.error, null);
  assert.equal(digest.counts.tool_errors, 0);
  // 工具预览里的路径被提取为"动过的文件"
  assert.ok(digest.files.includes('src/app.ts'));
});

test('digest: 审批的请求与应答成对折叠', () => {
  const session = new HarnessSession({
    sessionId: 'hs_dg2', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'approval.request', command: 'rm -rf build', description: '', choices: ['once', 'deny'], raw: {} });
  const approvalId = String(session.replay(0).find((e) => e.event === 'approval.request')?.approval_id ?? '');
  assert.ok(approvalId, 'approval_id 必须在 emit 时就铸好');
  session.emit({ event: 'approval.responded', choice: 'once', approval_id: approvalId });

  const digest = buildDigest(session);
  assert.equal(digest.approvals.length, 1);
  assert.equal(digest.approvals[0].resolved, true);
  assert.equal(digest.approvals[0].choice, 'once');
  assert.equal(digest.approvals[0].command, 'rm -rf build');
});

test('receipt: 只在终态签发,非终态不出半截收据', () => {
  const session = new HarnessSession({
    sessionId: 'hs_rc1', spec: FAKE_SPEC, cwd: '/tmp', logPath: tempLog(),
  });
  session.emit({ event: 'user.message', text: 'go' });
  assert.equal(isTerminal(session.status), false);

  session.emit({ event: 'run.failed', error: '构建失败' });
  session.status = 'failed';
  assert.equal(isTerminal(session.status), true);

  const receipt = buildReceipt(session);
  assert.equal(receipt.object, 'leoagent.receipt');
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.error, '构建失败');
});

test('artifacts: 只列 cwd 内真实存在的文件,越界一律拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-art-'));
  fs.writeFileSync(path.join(dir, 'report.md'), '# hi');
  const session = new HarnessSession({
    sessionId: 'hs_ar1', spec: FAKE_SPEC, cwd: dir, logPath: tempLog(),
  });
  session.emit({ event: 'tool.started', tool: 'Write', preview: `写入 report.md 与 ../../etc/passwd`, tool_use_id: 'tu1' });

  const list = listArtifacts(session);
  assert.equal(list.length, 1, '只有 cwd 内真实存在的文件进清单');
  assert.equal(list[0].name, 'report.md');

  assert.ok(readArtifact(session, 'report.md'), 'cwd 内的产物可读');
  assert.equal(readArtifact(session, '../../etc/passwd'), null, '路径穿越必须被拒');
  assert.equal(readArtifact(session, '/etc/passwd'), null, '绝对路径必须被拒');
});

test('resume envelope: ok when after is at or past the watermark, gap otherwise', () => {
  assert.deepEqual(resumeEnvelope(5, 0), { type: 'resume', status: 'ok', after: 5, min_after: 0 });
  assert.deepEqual(resumeEnvelope(5, 41), { type: 'resume', status: 'gap', after: 5, min_after: 41 });
});
