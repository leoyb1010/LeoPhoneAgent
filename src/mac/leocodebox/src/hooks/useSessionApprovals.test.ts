import test from 'node:test';
import assert from 'node:assert/strict';

import type { ServerEvent } from '../contexts/WebSocketContext';

import {
  approvalActionFromEvent,
  approvalsReducer,
  type ApprovalMap,
} from './useSessionApprovals';

const EMPTY: ApprovalMap = new Map();

/** 把一串 websocket 帧喂进去,拿到最终的待审批表。 */
function run(events: ServerEvent[]): ApprovalMap {
  return events.reduce<ApprovalMap>((state, event) => {
    const action = approvalActionFromEvent(event);
    return action ? approvalsReducer(state, action) : state;
  }, EMPTY);
}

const ids = (state: ApprovalMap) => [...state.keys()].sort();

test('普通输出不算待审批 —— 这正是"点进去什么都没有"的病根', () => {
  const state = run([
    { kind: 'text', sessionId: 's1', content: 'hi' },
    { kind: 'tool_use', sessionId: 's1' },
    { kind: 'thinking', sessionId: 's1' },
    { kind: 'session_upserted', sessionId: 's1' },
  ]);
  assert.deepEqual(ids(state), []);
});

test('permission_request 才挂标签,同一个 requestId 重复到达不翻倍', () => {
  const state = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_request', sessionId: 's1', requestId: 'r2' },
  ]);
  assert.deepEqual(ids(state), ['s1']);
  assert.equal(state.get('s1')?.size, 2);
});

test('取消/超时清掉对应请求,清空后整条会话从表里消失', () => {
  const state = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_request', sessionId: 's1', requestId: 'r2' },
    { kind: 'permission_cancelled', sessionId: 's1', requestId: 'r1' },
  ]);
  assert.deepEqual([...(state.get('s1') ?? [])], ['r2']);

  const cleared = approvalsReducer(state, { type: 'resolve', sessionId: 's1', requestIds: ['r2'] });
  assert.deepEqual(ids(cleared), []);
});

test('permission_cancelled 不带 sessionId 时按 requestId 全表清', () => {
  const state = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_cancelled', requestId: 'r1' },
  ]);
  assert.deepEqual(ids(state), []);
});

test('run 结束(complete)必须清干净,不能留着过期标签', () => {
  const state = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_request', sessionId: 's2', requestId: 'r9' },
    { kind: 'complete', sessionId: 's1', success: true },
  ]);
  assert.deepEqual(ids(state), ['s2']);
});

test('用户答复后由 resolve 销号 —— 服务端不回广播,只能靠这条', () => {
  const pending = run([{ kind: 'permission_request', sessionId: 's1', requestId: 'r1' }]);
  const answered = approvalsReducer(pending, {
    type: 'resolve',
    sessionId: 's1',
    requestIds: ['r1'],
  });
  assert.deepEqual(ids(answered), []);
});

test('chat_subscribed 的 ack 是权威快照,整份覆盖(包括覆盖成空)', () => {
  const stale = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'permission_request', sessionId: 's1', requestId: 'r2' },
  ]);

  const synced = run([
    { kind: 'permission_request', sessionId: 's1', requestId: 'r1' },
    { kind: 'chat_subscribed', sessionId: 's1', isProcessing: true, pendingPermissions: [{ requestId: 'r7' }] },
  ]);
  assert.deepEqual([...(synced.get('s1') ?? [])], ['r7']);

  const emptied = approvalsReducer(stale, { type: 'sync', sessionId: 's1', requestIds: [] });
  assert.deepEqual(ids(emptied), []);
});

test('没有变化时返回同一个引用,不做无谓重渲染', () => {
  const state = run([{ kind: 'permission_request', sessionId: 's1', requestId: 'r1' }]);
  assert.equal(approvalsReducer(state, { type: 'clear', sessionId: 's2' }), state);
  assert.equal(approvalsReducer(state, { type: 'resolve', sessionId: 's1', requestIds: ['nope'] }), state);
  assert.equal(approvalsReducer(state, { type: 'sync', sessionId: 's1', requestIds: ['r1'] }), state);
});

test('缺 sessionId 或 requestId 的帧直接忽略,不产生动作', () => {
  assert.equal(approvalActionFromEvent({ kind: 'permission_request', requestId: 'r1' }), null);
  assert.equal(approvalActionFromEvent({ kind: 'permission_request', sessionId: 's1' }), null);
  assert.equal(approvalActionFromEvent({ kind: 'complete' }), null);
});
