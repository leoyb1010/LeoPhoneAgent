import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { addHiddenSessionKey, applyEvent, boundWindowChipKind, boundWindowFromUnknown, clickPointFromElement, composerCanFollowUp, composerNeedsModelSwitch, composerPlaceholder, composerRunningHint, composerShouldFocus, composerShouldSend, composerShowsSteer, continueSessionDraft, countFilteredSessions, emptyView, endedComposerLead, endedSessionHint, flowFindActLabel, flowFindEmptyHint, flowFindHitKeys, flowFindHits, flowFindHitText, flowFindStatus, flowRowMatchesQuery, followUpToast, highlightQueryParts, formatContextWindow, hiddenHistoryHint, homeEmptyCopy, humanizeError, isHistoryStatus, isLiveRow, isSameMachineName, keepActiveSession, lastLine, localCreateNeedsSettings, markupParts, mentionWindowRead, mergeSameMachineSessions, modelChoiceHint, modelLabel, modelLikelyUnusable, nextFlowFindIndex, nextFocusIndex, nextProbeHealth, nextSessionIndex, nextUnseen, pendingFollowUps, pickInitialCwd, pickInitialModel, prettyModelName, prettifyUnknownModel, queueClearedToast, rankModelsForPicker, readHiddenSessionKeys, rejectedCodexModelId, scrollDeltaFromWheel, sessionCanDrive, sessionCanForget, sessionCanResume, sessionFailTexts, sessionKey, sessionLooksFailed, sessionMatchesFilter, sessionMatchesQuery, sessionNeedsSettings, settingsNeededCopy, shouldReconnectSessionStream, statusDot, statusDotForSession, usableWindowMenus, userTurnLabel, userTurnMode, windowBoundLabel, windowMenuLabel, windowPadGesture } from './model';

test('流水把思考事件折成独立行,后续 delta 续在同一行', () => {
  let view = emptyView();
  view = applyEvent(view, { event: 'reasoning.available', text: '先看目录' });
  view = applyEvent(view, { event: 'reasoning.available', text: '再改文件' });
  view = applyEvent(view, { event: 'message.delta', delta: '好的' });
  assert.equal(view.rows.length, 2);
  assert.equal(view.rows[0]?.k, 'think');
  if (view.rows[0]?.k === 'think') {
    assert.equal(view.rows[0].text, '先看目录再改文件');
    assert.equal(view.rows[0].streaming, false);
  }
  assert.equal(view.rows[1]?.k, 'ai');
});

test('同一 seq 再来一次不会把用户行画两遍', () => {
  const first = applyEvent(emptyView(), { event: 'user.message', seq: 4, text: '只说一次' });
  const again = applyEvent(first, { event: 'user.message', seq: 4, text: '只说一次' });
  assert.equal(again.rows.length, 1);
  assert.equal(again.seq, 4);
  assert.equal(again.rows, first.rows);
});

test('审批 Map 按事件拷贝,不会改写上一帧', () => {
  const first = applyEvent(emptyView(), { event: 'approval.request', approval_id: 'a1', command: 'ls', choices: ['once', 'deny'] });
  const second = applyEvent(first, { event: 'approval.request', approval_id: 'a2', command: 'rm', choices: ['once', 'deny'] });
  assert.equal(first.pendingApprovals.size, 1);
  assert.equal(second.pendingApprovals.size, 2);
  assert.ok(first.pendingApprovals.has('a1'));
  assert.ok(!first.pendingApprovals.has('a2'));
});

test('思考深度回执变成系统行', () => {
  const view = applyEvent(emptyView(), { event: 'session.thinking', level: 'high' });
  assert.equal(view.thinking, 'high');
  assert.equal(view.rows[0]?.k, 'sys');
  if (view.rows[0]?.k === 'sys') assert.match(view.rows[0].text, /高/);
});

test('内核翻译出错会落成一条能看的系统行', () => {
  const view = applyEvent(emptyView(), { event: 'harness.translate_error', text: 'No API key found' });
  assert.equal(view.rows[0]?.k, 'sys');
  if (view.rows[0]?.k === 'sys') assert.match(view.rows[0].text, /设置/);
});

test('切换模型的系统行用产品名', () => {
  const view = applyEvent(emptyView(), { event: 'session.model', provider: 'xai', model_id: 'grok-4.6' });
  assert.equal(view.model, 'xai/grok-4.6');
  if (view.rows[0]?.k === 'sys') assert.match(view.rows[0].text, /Grok 4\.6/);
});

test('模型名、上下文窗口、轻标记与报错中文', () => {
  assert.equal(modelLabel('anthropic/claude-opus-4-7'), 'claude-opus-4-7');
  assert.equal(formatContextWindow(200_000), '200K');
  assert.equal(formatContextWindow(1_048_576), '1M');
  const parts = markupParts('用 `ls` 看,**然后**走');
  assert.deepEqual(parts, [
    { k: 'text', v: '用 ' },
    { k: 'code', v: 'ls' },
    { k: 'text', v: ' 看,' },
    { k: 'strong', v: '然后' },
    { k: 'text', v: '走' },
  ]);
  assert.match(humanizeError('No API key found for the selected model.'), /设置/);
  assert.match(humanizeError('Rate limit exceeded 429'), /限流/);
  assert.match(humanizeError('relay 404'), /产物接口/);
  assert.match(humanizeError('maximum context window exceeded'), /压缩/);
  assert.equal(lastLine({ status: 'running', last_event: { event: 'reasoning.available', text: '…', timestamp: 1 }, pending_approvals: [] }), '正在想…');
  assert.equal(lastLine({ status: 'running', last_event: { event: 'user.message', text: '先停一下', timestamp: 1, mode: 'steer' }, pending_approvals: [] }), '插话:先停一下');
  assert.equal(lastLine({ status: 'idle', last_event: { event: 'user.message', text: '写个文件', timestamp: 1 }, pending_approvals: [] }), '你:写个文件');
  assert.equal(prettyModelName('anthropic/claude-opus-5'), 'Claude Opus 5');
  assert.equal(prettyModelName('xai/grok-4.6'), 'Grok 4.6');
  assert.equal(prettyModelName('openai/gpt-5.6-sol'), 'GPT-5.6 Sol');
  assert.equal(prettyModelName('google/gemini-3.8-flash'), 'Gemini 3.8 Flash');
  assert.equal(prettyModelName('zhipu/glm-5.3'), 'GLM-5.3');
  assert.equal(prettyModelName('unknown/totally-new', 'Totally New'), 'Totally New');
  assert.equal(prettyModelName('vendor/qwen3-coder'), 'Qwen3 Coder');
  assert.equal(prettifyUnknownModel('new-model-x'), 'New Model X');
  assert.equal(lastLine({ status: 'waiting_for_approval', last_event: null, pending_approvals: [{ approval_id: 'a', command: 'rm -rf /tmp/x', choices: ['once'] }] }), '需要确认:rm -rf /tmp/x');
  assert.equal(lastLine({ status: 'idle', last_event: { event: 'run.completed', text: '', timestamp: 1 }, pending_approvals: [] }), '已完成');
  assert.match(lastLine({ status: 'failed', last_event: { event: 'run.failed', text: 'No API key found', timestamp: 1 }, pending_approvals: [] }), /设置/);
  assert.equal(lastLine({ status: 'orphaned', last_event: { event: 'user.message', text: '还在说', timestamp: 1 }, pending_approvals: [] }), '上次运行留下的记录');
  assert.equal(lastLine({ status: 'completed', last_event: { event: 'user.message', text: '旧句', timestamp: 1 }, pending_approvals: [] }), '已完成');
});

test('只有正在发生的行才算 live,探测失败两轮才过期', () => {
  const view = applyEvent(emptyView(), { event: 'message.delta', delta: 'hi' });
  assert.equal(view.rows[0] && isLiveRow(view.rows[0]), true);
  const done = applyEvent(view, { event: 'run.completed' });
  assert.equal(done.rows[0] && isLiveRow(done.rows[0]), false);
  assert.deepEqual(nextProbeHealth(0, true), { fails: 0, stale: false });
  assert.deepEqual(nextProbeHealth(0, false), { fails: 1, stale: false });
  assert.deepEqual(nextProbeHealth(1, false), { fails: 2, stale: true });
  assert.equal(composerShouldSend({ key: 'Enter', shiftKey: false }), true);
  assert.equal(composerShouldSend({ key: 'Enter', shiftKey: true }), false);
  assert.equal(composerShouldSend({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } }), false);
  assert.equal(nextUnseen(3, true, true), 0);
  assert.equal(nextUnseen(3, true, false), 4);
  assert.match(endedSessionHint('orphaned'), /进程已不在/);
  assert.deepEqual(continueSessionDraft({ machine: 'fold', cwd: ' /tmp/x ', prompt: ' 接着改 ', model: 'xai/grok-4.6' }), { open: true, machine: 'fold', cwd: '/tmp/x', prompt: '接着改', model: 'xai/grok-4.6' });
  assert.deepEqual(continueSessionDraft({ machine: '', cwd: '', prompt: '  ' }), { open: true, machine: 'local' });
  assert.deepEqual(continueSessionDraft({ machine: 'local', model: 'openai-codex/gpt-5.3-codex-spark' }), { open: true, machine: 'local' });
  assert.equal(nextUnseen(3, false, false), 3);
  assert.equal(nextSessionIndex(0, -1, 1), -1);
  assert.equal(nextSessionIndex(4, -1, 1), 0);
  assert.equal(nextSessionIndex(4, 0, -1), 0);
  assert.equal(nextSessionIndex(4, 2, 1), 3);
  assert.equal(pickInitialModel([{ provider: 'anthropic', id: 'claude-opus-5' }, { provider: 'xai', id: 'grok-4.6' }], 'xai/grok-4.6'), 'xai/grok-4.6');
  assert.equal(pickInitialModel([{ provider: 'anthropic', id: 'claude-opus-5' }], 'gone/old'), 'gone/old');
  assert.equal(pickInitialModel([{ provider: 'anthropic', id: 'claude-opus-5' }], ''), 'anthropic/claude-opus-5');
  assert.equal(pickInitialModel([
    { provider: 'openai-codex', id: 'gpt-5.3-codex-spark' },
    { provider: 'openai-codex', id: 'gpt-5.4' },
    { provider: 'openai-codex', id: 'gpt-5.4-mini' },
    { provider: 'openai-codex', id: 'gpt-5.5' },
  ], ''), 'openai-codex/gpt-5.5');
  assert.equal(pickInitialModel([
    { provider: 'openai-codex', id: 'gpt-5.3-codex-spark' },
    { provider: 'openai-codex', id: 'gpt-5.5' },
  ], 'openai-codex/gpt-5.3-codex-spark'), 'openai-codex/gpt-5.5');
  assert.deepEqual(rankModelsForPicker([
    { provider: 'openai-codex', id: 'gpt-5.3-codex-spark' },
    { provider: 'openai-codex', id: 'gpt-5.5' },
    { provider: 'openai-codex', id: 'gpt-5.4' },
  ], modelLikelyUnusable).map((m) => m.id), ['gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-5.4']);
  assert.match(humanizeError("Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."), /ChatGPT/);
  assert.equal(modelLikelyUnusable('openai-codex/gpt-5.3-codex-spark'), true);
  assert.equal(modelLikelyUnusable({ provider: 'openai-codex', id: 'gpt-5.5' }), false);
  assert.equal(modelChoiceHint({ provider: 'openai-codex', id: 'gpt-5.4' }), '当前 ChatGPT 登录可能用不了');
  assert.equal(rejectedCodexModelId("Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."), 'gpt-5.3-codex-spark');
  assert.equal(composerNeedsModelSwitch('openai-codex/gpt-5.3-codex-spark', ["Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."]), true);
  assert.equal(composerNeedsModelSwitch('openai-codex/gpt-5.5', ["Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."]), false);
  const failTexts = sessionFailTexts({
    lastEventText: 'ok',
    rows: [
      { k: 'ai', text: 'ignore' },
      { k: 'sys', text: "Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account." },
    ],
  });
  assert.deepEqual(failTexts[0], 'ok');
  assert.equal(composerNeedsModelSwitch('openai-codex/gpt-5.3-codex-spark', failTexts), true);
  assert.equal(composerNeedsModelSwitch('openai-codex/gpt-5.3-codex-spark', [failTexts[0]]), false);
  assert.equal(statusDotForSession({ status: 'idle', last_event: { event: 'run.failed' } }), 'err');
  assert.equal(statusDot('idle'), 'idle');
  assert.match(humanizeError('ETIMEDOUT connecting relay'), /超时|机器/);
  assert.match(humanizeError('session is not running'), /接着这条聊/);
  assert.match(humanizeError('这条会话没有可续的内核记录。只能在同一目录新开。'), /没有可续的内核记录/);
  assert.equal(sessionCanResume({ machine: 'local', harness: 'pi', status: 'orphaned', resumable: true }), true);
  assert.equal(sessionCanResume({ machine: 'local', harness: 'pi', status: 'orphaned', resumable: false }), false);
  assert.equal(sessionCanResume({ machine: 'fold', harness: 'pi', status: 'orphaned', resumable: true }), false);
  assert.equal(sessionCanResume({ machine: 'local', harness: 'codex', status: 'orphaned', resumable: true }), false);
  assert.equal(sessionCanResume({ machine: 'local', harness: 'pi', status: 'idle', resumable: true }), false);
  const resumed = applyEvent(emptyView(), { event: 'session.resumed', cwd: '/tmp/x' });
  assert.equal(resumed.status, 'starting');
  const last = resumed.rows.at(-1);
  assert.equal(last?.k, 'sys');
  if (last?.k === 'sys') assert.match(last.text, /接着上次的上下文/);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /continueLocal/);
  assert.match(app, /接着这条会话/);
  assert.match(app, /sessionCanResume/);
  assert.match(humanizeError('ECONNREFUSED http://127.0.0.1:5020/v1'), /连不上/);
  assert.match(humanizeError('HTTP 502 bad gateway'), /暂时不可用/);
  const rail = keepActiveSession(
    [{ session_id: 'live' }, { session_id: 'done' }],
    (s) => s.session_id === 'live',
    'done',
  );
  assert.deepEqual(rail.map((s) => s.session_id), ['live', 'done']);
  assert.equal(sessionCanDrive('idle', 'idle'), true);
  assert.equal(sessionCanDrive('completed', 'idle'), false);
  assert.equal(sessionCanDrive('cancelled', 'cancelled'), false);
  assert.equal(sessionCanDrive('running', 'idle'), true);
  assert.equal(nextFocusIndex(3, 2, false), 0);
  assert.equal(nextFocusIndex(3, 0, true), 2);
  assert.equal(pickInitialCwd('~', '/tmp/proj'), '/tmp/proj');
  assert.equal(pickInitialCwd('/active', '/tmp/proj'), '/active');
});

test('前台窗口绑定会落成系统行,摘要里的窗口也能读出来', () => {
  const view = applyEvent(emptyView(), { event: 'window.bound', app: 'Finder', title: 'Documents', snapshot_id: 'snap-1' });
  assert.deepEqual(view.window, { app: 'Finder', title: 'Documents', snapshotId: 'snap-1' });
  assert.equal(view.rows[0]?.k, 'sys');
  if (view.rows[0]?.k === 'sys') assert.match(view.rows[0].text, /Finder · Documents/);
  assert.equal(windowBoundLabel({ app: 'Finder', title: 'Finder' }), 'Finder');
  assert.equal(windowBoundLabel(boundWindowFromUnknown({ app: 'Safari', title: 'Inbox', snapshot_id: 'x' })), 'Safari · Inbox');
  assert.equal(windowBoundLabel(boundWindowFromUnknown(null)), '');
  assert.equal(boundWindowChipKind('local', 'Finder · Documents'), 'raise');
  assert.equal(boundWindowChipKind('LeodeMac-mini-2', 'Finder · Documents'), 'label');
  assert.equal(boundWindowChipKind('local', ''), 'bind');
  assert.equal(boundWindowChipKind('fold', ''), 'none');
  const box = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(clickPointFromElement(180, 80, box), { x: 0.4, y: 0.3 });
  assert.deepEqual(clickPointFromElement(100, 50, box), { x: 0.001, y: 0.001 });
  assert.equal(clickPointFromElement(90, 80, box), null);
  assert.deepEqual(scrollDeltaFromWheel(0, 120), { dy: 3 });
  assert.deepEqual(scrollDeltaFromWheel(-80, 0), { dx: -2 });
  assert.equal(scrollDeltaFromWheel(0, 0), null);
  assert.equal(windowPadGesture({ x: 0.2, y: 0.2 }, { x: 0.21, y: 0.2 }).kind, 'click');
  assert.deepEqual(windowPadGesture({ x: 0.2, y: 0.2 }, { x: 0.7, y: 0.8 }), { kind: 'drag', from: { x: 0.2, y: 0.2 }, to: { x: 0.7, y: 0.8 } });
  assert.equal(windowMenuLabel(['文件', '存储']), '文件 · 存储');
  assert.equal(mentionWindowRead('', '已经写好的字'), '已经写好的字');
  assert.equal(mentionWindowRead('看下\n', '已经写好的字'), '看下\n已经写好的字');
  assert.equal(mentionWindowRead('已经写好的字', '已经写好的字'), '已经写好的字');
  assert.equal(mentionWindowRead('看下', ''), '看下');
  assert.deepEqual(usableWindowMenus([
    { path: ['文件'], enabled: true },
    { path: ['文件', '存储'], enabled: true },
    { path: ['文件', '存储'], enabled: true },
    { path: ['编辑', '剪切'], enabled: false },
    { path: ['编辑', '拷贝'], enabled: true },
  ]), [{ path: ['文件', '存储'] }, { path: ['编辑', '拷贝'] }]);
});

test('进行中才显示插话,空闲仍是发送', () => {
  assert.equal(composerShowsSteer('running'), true);
  assert.equal(composerShowsSteer('starting'), true);
  assert.equal(composerShowsSteer('idle'), false);
  assert.equal(composerShowsSteer('waiting_for_approval'), false);
});

test('本机进行中才能排队下一句,远程仍只有插话', () => {
  assert.equal(composerCanFollowUp('local', 'running'), true);
  assert.equal(composerCanFollowUp('local', 'starting'), true);
  assert.equal(composerCanFollowUp('local', 'idle'), false);
  assert.equal(composerCanFollowUp('fold', 'running'), false);
  assert.match(composerRunningHint('Grok 4.6', true), /接着会排在后面/);
  assert.match(composerRunningHint('Grok 4.6', false), /插话/);
  assert.doesNotMatch(composerRunningHint('Grok 4.6', false), /接着会排/);
  const afterPrompt = applyEvent(emptyView(), { event: 'user.message', text: '先改这一处' });
  const queued = applyEvent(afterPrompt, { event: 'user.message', text: '再说第二处', mode: 'follow_up' });
  assert.deepEqual(pendingFollowUps(queued.rows), [{ key: queued.rows[1]?.k === 'user' ? queued.rows[1].key : '', text: '再说第二处' }]);
  const cleared = applyEvent(queued, { event: 'session.queue_cleared' });
  assert.deepEqual(pendingFollowUps(cleared.rows), []);
  const last = cleared.rows[cleared.rows.length - 1];
  if (last?.k === 'sys') assert.match(last.text, /已取消排队/);
  assert.equal(followUpToast(), '已排在后面,这轮说完再执行');
  assert.equal(queueClearedToast(), '已取消排队的下一句');
});

test('2.0 壳接上了插话、回车开会话和前台窗口', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /composerShowsSteer/);
  assert.match(app, />插话</);
  assert.match(app, />接着</);
  assert.match(app, /type: 'follow_up'/);
  assert.match(app, /type: 'clear_queue'/);
  assert.match(app, /composerCanFollowUp/);
  assert.match(app, /windowBoundLabel/);
  assert.match(app, /boundWindowChipKind/);
  assert.match(app, /raiseBoundWindow/);
  assert.match(app, /clickBoundWindow/);
  assert.match(app, /typeBoundWindow/);
  assert.match(app, /readBoundWindow/);
  assert.match(app, /mentionWindowRead/);
  assert.match(app, /读回来/);
  assert.match(app, /keyBoundWindow/);
  assert.match(app, /scrollBoundWindow/);
  assert.match(app, /dragBoundWindow/);
  assert.match(app, /listBoundWindowMenus/);
  assert.match(app, /menuBoundWindow/);
  assert.match(app, /windowMenuLabel/);
  assert.match(app, /listSessionWindows/);
  assert.match(app, /bindSessionWindow/);
  assert.match(app, /peekBoundWindow/);
  assert.match(app, /WINDOW_KEY_BUTTONS/);
  assert.match(app, /点一下提到前面/);
  assert.match(app, /绑窗口/);
  assert.match(flow, /composerShouldSend/);
  assert.match(flow, /↩ 开始/);
});

test('结束的会话才能从左栏拿掉,隐藏名单按机器加 id 记', () => {
  assert.equal(sessionCanForget('orphaned'), true);
  assert.equal(sessionCanForget('completed'), true);
  assert.equal(sessionCanForget('failed'), true);
  assert.equal(sessionCanForget('running'), false);
  assert.equal(sessionCanForget('idle'), false);
  assert.equal(shouldReconnectSessionStream('running'), true);
  assert.equal(shouldReconnectSessionStream('idle'), true);
  assert.equal(shouldReconnectSessionStream('orphaned'), false);
  assert.equal(shouldReconnectSessionStream('cancelled'), false);
  assert.equal(shouldReconnectSessionStream('completed'), false);
  assert.equal(shouldReconnectSessionStream('failed'), false);
  assert.equal(sessionKey('local', 'hs_1'), 'local:hs_1');
  assert.deepEqual(readHiddenSessionKeys(null), []);
  assert.deepEqual(readHiddenSessionKeys('["local:hs_1"]'), ['local:hs_1']);
  assert.deepEqual(addHiddenSessionKey(['local:hs_1'], 'local:hs_1'), ['local:hs_1']);
  assert.deepEqual(addHiddenSessionKey(['local:hs_1'], 'fold:hs_2'), ['local:hs_1', 'fold:hs_2']);
  assert.match(humanizeError('session is still running'), /停止/);
});

test('筛选数字包含正在看的历史会话,失败过的孤儿也算失败', () => {
  const rows = [
    { session_id: 'live', status: 'running', last_event: null },
    { session_id: 'dead', status: 'orphaned', last_event: { event: 'run.failed', text: 'x', timestamp: 1 } },
  ];
  assert.equal(sessionLooksFailed(rows[1]!), true);
  assert.equal(sessionMatchesFilter(rows[1]!, 'err'), true);
  assert.equal(sessionMatchesFilter(rows[1]!, 'history'), true);
  assert.equal(sessionMatchesFilter(rows[1]!, 'all'), false);
  assert.equal(countFilteredSessions(rows, 'all', null), 1);
  assert.equal(countFilteredSessions(rows, 'all', 'dead'), 2);
  assert.equal(countFilteredSessions(rows, 'err', null), 1);
  assert.equal(countFilteredSessions(rows, 'active', 'dead'), 1);
  assert.equal(countFilteredSessions(rows, 'need', 'dead'), 0);
  assert.equal(hiddenHistoryHint('all', 23, true), '还有 22 条历史');
  assert.equal(hiddenHistoryHint('all', 23, false), '还有 23 条历史');
  assert.equal(hiddenHistoryHint('all', 1, true), '');
  assert.equal(hiddenHistoryHint('history', 23, false), '');
  assert.equal(isHistoryStatus('orphaned'), true);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /hiddenHistoryHint/);
  assert.match(app, /rail-more/);
});

test('点开死会话不会把进行中和需要你加一,同机中继多出来的会话并进本机', () => {
  const rows = [
    { session_id: 'dead', status: 'orphaned', last_event: { event: 'run.failed', text: 'x', timestamp: 1 } },
  ];
  assert.equal(countFilteredSessions(rows, 'all', 'dead'), 1);
  assert.equal(countFilteredSessions(rows, 'active', 'dead'), 0);
  assert.equal(countFilteredSessions(rows, 'need', 'dead'), 0);
  assert.deepEqual(mergeSameMachineSessions([{ session_id: 'a' }, { session_id: 'b' }], [{ session_id: 'b' }, { session_id: 'c' }]).map((s) => s.session_id), ['a', 'b', 'c']);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mergeSameMachineSessions/);
});

test('没登录的失败要去设置,本机名带不带 .local 算同一台', () => {
  assert.equal(sessionNeedsSettings(['No API key found for the selected model.']), true);
  assert.equal(sessionNeedsSettings(['失败:这个模型还没有登录或密钥 —— 到「设置」登录一个供应商后再试']), true);
  assert.equal(sessionNeedsSettings(['已停止。进程不在了']), false);
  assert.equal(sessionNeedsSettings(["Codex error: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."]), false);
  assert.equal(isSameMachineName('LeoyuandeMacBook-Pro-2.local', 'LeoyuandeMacBook-Pro-2'), true);
  assert.equal(isSameMachineName('fold', 'LeoyuandeMacBook-Pro-2'), false);
});

test('2.0 壳接上了从左栏拿掉', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /forgetSession/);
  assert.match(app, /从左栏拿掉/);
  assert.match(app, /onContextMenu/);
  assert.match(app, /api\.forget/);
  assert.match(app, /sessionNeedsSettings/);
  assert.match(app, />去设置</);
  assert.match(app, /isSameMachineName/);
  assert.match(app, /composerPlaceholder/);
  assert.match(app, /composer ended/);
  assert.match(app, /shead-t/);
  assert.match(app, /点一下复制/);
  assert.match(app, /onClick=\{\(\) => void copyTitle\(\)\}/);
});

test('左栏按标题目录模型找会话,没登录的创建错误说人话', () => {
  assert.equal(sessionMatchesQuery({ title: '在吗', cwd: '/tmp', model: 'anthropic/claude' }, ''), true);
  assert.equal(sessionMatchesQuery({ title: '在吗', cwd: '/tmp', model: 'anthropic/claude' }, '在'), true);
  assert.equal(sessionMatchesQuery({ title: '在吗', cwd: '/Users/leo/src', model: null }, 'src'), true);
  assert.equal(sessionMatchesQuery({ title: '在吗', cwd: '/tmp', model: 'openai/gpt' }, 'claude'), false);
  assert.match(humanizeError('还没有登录任何模型。先去设置里授权或填密钥。'), /设置/);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /sessionMatchesQuery/);
  assert.match(app, /rail-find/);
  assert.match(app, /rankModelsForPicker\(usableModelsFromProviders\(providers/);
});

test('没模型时主区和新建都去设置,不假装能开会话', () => {
  assert.equal(localCreateNeedsSettings(0), true);
  assert.equal(localCreateNeedsSettings(2), false);
  assert.equal(homeEmptyCopy({ modelCount: 0 }).action, 'settings');
  assert.equal(homeEmptyCopy({ modelCount: 0 }).title, '还没有可用模型');
  assert.equal(homeEmptyCopy({ modelCount: 0, providersReady: false }).action, 'none');
  assert.match(homeEmptyCopy({ modelCount: 0, providersReady: false }).title, /读取/);
  assert.equal(homeEmptyCopy({ modelCount: 1 }).action, 'none');
  assert.equal(homeEmptyCopy({ loadError: 'ECONNREFUSED', modelCount: 0 }).action, 'retry');
  assert.match(settingsNeededCopy().title, /不能用/);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /beginLocalNew/);
  assert.match(app, /homeEmptyCopy/);
  assert.match(app, /settingsNeededCopy/);
});

test('插话在流水里标成插话,不跟首句混成「你」', () => {
  assert.equal(userTurnMode({}), 'prompt');
  assert.equal(userTurnMode({ mode: 'steer' }), 'steer');
  assert.equal(userTurnMode({ steer: true }), 'steer');
  assert.equal(userTurnLabel('steer'), '插话');
  assert.equal(userTurnLabel('follow_up'), '接着');
  assert.equal(userTurnLabel('prompt'), '你');
  const prompt = applyEvent(emptyView(), { event: 'user.message', text: '数到 40' });
  const steered = applyEvent(prompt, { event: 'user.message', text: '停', mode: 'steer' });
  assert.equal(prompt.title, '数到 40');
  assert.equal(steered.title, '数到 40');
  assert.equal(steered.rows[1]?.k, 'user');
  if (steered.rows[1]?.k === 'user') assert.equal(steered.rows[1].mode, 'steer');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  const session = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(flow, /userTurnLabel/);
  assert.match(flow, /frow-\$\{mode\}/);
  assert.match(css, /\.frow-steer/);
  assert.match(session, /mode: outgoing\.type/);
  assert.match(session, /mode: 'prompt'/);
});

test('模型还在跑时插话走 steer,思考深度发 level', () => {
  assert.equal(composerShowsSteer('running'), true);
  assert.equal(composerShowsSteer('starting'), true);
  assert.equal(composerShowsSteer('idle'), false);
  assert.match(humanizeError('Agent is already processing. Specify streamingBehavior (\'steer\' or \'followUp\') to queue the message.'), /接着会排在后面/);
  const sessionSrc = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(sessionSrc, /outgoing\.type === 'clear_queue'/);
  assert.match(sessionSrc, /session\.queue_cleared/);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /type: 'set_thinking_level', level/);
  assert.doesNotMatch(app, /thinkingLevel: level/);
  const session = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(session, /piTurnCommandType/);
  assert.match(session, /type: 'steer'/);
});

test('ChatGPT 拒掉当前模型时要换模型,不要再用同一个 id 发', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /composerNeedsModelSwitch/);
  assert.match(app, /sessionFailTexts/);
  assert.match(app, /!needsModelSwitch/);
  assert.match(app, /shouldReconnectSessionStream/);
  assert.match(app, /换模型/);
  assert.match(app, /statusDotForSession/);
  assert.match(flow, /modelLikelyUnusable/);
  assert.match(flow, /modelChoiceHint/);
});

test('本机文件抽屉按会话目录登记真实项目,不编 harness- id', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const api = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
  assert.match(api, /ensureWorkspace/);
  assert.match(app, /api\.ensureWorkspace/);
  assert.match(app, /workspace\?\.projectId/);
  assert.match(app, /isWorkspaceDrawer/);
  assert.match(app, /isPeekDrawer/);
  assert.match(app, /Shell selectedProject=\{workspace\}/);
  assert.doesNotMatch(app, /harness-\$\{/);
});

test('新会话面板抬入,打开时左栏滚到顶', () => {
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(css, /\.leo2 \.newbox\{[^}]*animation:leo2-rise/);
  assert.match(app, /railListRef\.current\?\.scrollTo/);
  assert.match(app, /newBox\?\.open/);
});

test('输入框占位写出目录名,空页抬入', () => {
  assert.match(composerPlaceholder('leo-codex-live', false), /对 leo-codex-live 说点什么/);
  assert.match(composerPlaceholder('leo-codex-live', true), /带到 leo-codex-live 的新会话/);
  assert.match(composerPlaceholder('', false), /对这条会话说点什么/);
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(css, /\.leo2 \.empty-main\{[^}]*animation:leo2-rise/);
  assert.match(app, /composerPlaceholder\(cwdChipLabel\(cwd\)/);
});

test('点开会话就能写,抽屉和弹层开着不抢焦点', () => {
  const clear = { hasSession: true, view: 'home', drawer: null, newBoxOpen: false, paletteOpen: false, pickerOpen: false, whatsNewOpen: false };
  assert.equal(composerShouldFocus(clear), true);
  assert.equal(composerShouldFocus({ ...clear, hasSession: false }), false);
  assert.equal(composerShouldFocus({ ...clear, view: 'settings' }), false);
  assert.equal(composerShouldFocus({ ...clear, drawer: 'files' }), false);
  assert.equal(composerShouldFocus({ ...clear, newBoxOpen: true }), false);
  assert.equal(composerShouldFocus({ ...clear, whatsNewOpen: true }), false);
  assert.equal(composerShouldFocus({ ...clear, windowOpOpen: true }), false);
  assert.equal(composerShouldFocus({ ...clear, flowFindOpen: true }), false);
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(css, /\.leo2 \.composer\{[^}]*animation:leo2-rise/);
  assert.match(app, /composerShouldFocus/);
  assert.match(app, /taRef\.current\?\.focus/);
});

test('流水查找按正文和文件名匹配,空查询不算命中', () => {
  const user = { k: 'user' as const, key: '1', text: '只写一个文件 ART31.txt' };
  const edit = { k: 'edit' as const, key: '2', toolUseId: null, tool: 'write', file: 'ART31.txt', output: '', running: false, error: false };
  const ai = { k: 'ai' as const, key: '3', text: '写完了', streaming: false };
  assert.equal(flowRowMatchesQuery(user, 'art31'), true);
  assert.equal(flowRowMatchesQuery(edit, 'ART31'), true);
  assert.equal(flowRowMatchesQuery(ai, 'ART31'), false);
  assert.equal(flowFindHits([user, edit, ai], 'ART31'), 2);
  assert.equal(flowFindHits([user, edit, ai], ''), 0);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(app, /flowRowMatchesQuery/);
  assert.match(app, /flow-find/);
  assert.match(app, /toLowerCase\(\) === 'f'/);
  assert.match(css, /\.flow-find\{/);
  assert.match(css, /\.frow-miss/);
});

test('查找下一条会绕回,状态写成 当前 / 总数', () => {
  const rows = [
    { k: 'user' as const, key: 'u', text: 'ART31 first' },
    { k: 'sys' as const, key: 's', text: '窗口', tone: 'muted' as const },
    { k: 'edit' as const, key: 'e', toolUseId: null, tool: 'write', file: 'ART31.txt', output: '', running: false, error: false },
  ];
  assert.deepEqual(flowFindHitKeys(rows, 'ART31'), ['u', 'e']);
  assert.equal(nextFlowFindIndex(2, 0, 1), 1);
  assert.equal(nextFlowFindIndex(2, 1, 1), 0);
  assert.equal(nextFlowFindIndex(2, 0, -1), 1);
  assert.equal(nextFlowFindIndex(0, 0, 1), -1);
  assert.equal(flowFindStatus(3, 0), '1 / 3');
  assert.equal(flowFindStatus(0, 0), '0 条');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(app, /toLowerCase\(\) === 'g'/);
  assert.match(app, /data-flow-key/);
  assert.match(app, /frow-hit/);
  assert.match(css, /\.frow-hit\{/);
});

test('查找把命中标在正文里,已结束输入区收成一行', () => {
  assert.deepEqual(highlightQueryParts('写 ART31.txt', 'art31'), [
    { t: '写 ', hit: false },
    { t: 'ART31', hit: true },
    { t: '.txt', hit: false },
  ]);
  assert.deepEqual(highlightQueryParts('没有', 'ART31'), [{ t: '没有', hit: false }]);
  assert.deepEqual(highlightQueryParts('abc', ''), [{ t: 'abc', hit: false }]);
  assert.equal(endedComposerLead('orphaned'), '这是上次留下的记录,进程已不在');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(app, /query=\{flowFind\.query\}/);
  assert.match(app, /composer-end-hint/);
  assert.match(app, /endedComposerLead/);
  assert.doesNotMatch(app, /目录还在/);
  assert.match(flow, /className="find-hit"/);
  assert.match(flow, /highlightQueryParts/);
  assert.match(css, /mark\.find-hit/);
  assert.match(css, /\.composer-end\{[^}]*align-items:center/);
});

test('换会话会收起查找,不把上一条的关键词带到下一页', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /setFlowFind\(\{ open: false, query: '', index: 0 \}\)/);
  assert.match(app, /\[active\?\.machine, active\?\.id\]/);
});

test('查找当前命中可以整段复制', () => {
  assert.equal(flowFindHitText({ k: 'user', key: 'u', text: '只写 ART31.txt' }), '只写 ART31.txt');
  assert.equal(flowFindHitText({ k: 'edit', key: 'e', toolUseId: null, tool: 'write', file: 'ART31.txt', output: '', running: false, error: false }), 'ART31.txt');
  assert.equal(flowFindHitText(undefined), '');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /copyFindHit/);
  assert.match(app, /已复制命中/);
  assert.match(app, /toLowerCase\(\) === 'c'/);
});

test('查找条收成短按钮,框里方向键跳命中不切会话', () => {
  assert.equal(flowFindActLabel('prev'), '上');
  assert.equal(flowFindActLabel('next'), '下');
  assert.equal(flowFindActLabel('copy'), '复制');
  assert.equal(flowFindActLabel('close'), '关');
  assert.equal(flowFindEmptyHint(), '回车 · ↑↓');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(app, /flowFindActLabel\('prev'\)/);
  assert.match(app, /flowFindEmptyHint\(\)/);
  assert.match(app, /e\.key === 'ArrowDown'/);
  assert.doesNotMatch(app, />上一条</);
  assert.match(css, /\.flow-find-acts\{/);
});

test('查找开着时方向键一律跳命中,不必先点回输入框', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /if \(flowFind\.open\) \{\s*e\.preventDefault\(\);\s*stepFind/);
});

test('查找开着时收起输入区,流水多出一截', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('./v2.css', import.meta.url)), 'utf8');
  assert.match(app, /composer-wrap\$\{flowFind\.open \? ' find-away' : ''\}/);
  assert.match(css, /\.composer-wrap\.find-away\{[^}]*display:none/);
});
