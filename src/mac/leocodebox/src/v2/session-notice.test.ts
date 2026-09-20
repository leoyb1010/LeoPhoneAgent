import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { dockNeedBadge, noticesFromSnapshot, sessionPathTarget, type NoticeSession } from './session-notice.ts';

const row = (over: Partial<NoticeSession> & Pick<NoticeSession, 'key' | 'status'>): NoticeSession => ({
  machine: 'local',
  id: over.key.split(':')[1] ?? over.key,
  title: '改按钮',
  ...over,
});

test('程序坞角标只数还在等批准的会话', () => {
  assert.equal(dockNeedBadge([
    { status: 'waiting_for_approval' },
    { status: 'running' },
    { status: 'waiting_for_approval' },
    { status: 'idle' },
  ]), 2);
});

test('第一次快照:窗口在前不弹;不在前且已有待批就弹一条', () => {
  const next = [row({ key: 'local:a', status: 'waiting_for_approval', command: 'rm build' })];
  const focused = noticesFromSnapshot({ primed: false, prev: new Map(), next, activeKey: null, windowFocused: true });
  assert.equal(focused.notices.length, 0);
  const away = noticesFromSnapshot({ primed: false, prev: new Map(), next, activeKey: null, windowFocused: false });
  assert.equal(away.notices[0]?.kind, 'need');
  assert.match(away.notices[0]?.body ?? '', /rm build/);
});

test('盯着这条且窗口在前,批准失败都不弹;离开才弹', () => {
  const prev = new Map([['local:a', 'running']]);
  const need = [row({ key: 'local:a', status: 'waiting_for_approval', command: 'ls\nmore' })];
  const watching = noticesFromSnapshot({ primed: true, prev, next: need, activeKey: 'local:a', windowFocused: true });
  assert.equal(watching.notices.length, 0);
  const other = noticesFromSnapshot({ primed: true, prev, next: need, activeKey: 'local:b', windowFocused: true });
  assert.equal(other.notices[0]?.kind, 'need');
  assert.equal(other.notices[0]?.body, '需要确认：ls');
  const fail = noticesFromSnapshot({
    primed: true, prev, next: [row({ key: 'local:a', status: 'failed' })],
    activeKey: 'local:a', windowFocused: false,
  });
  assert.equal(fail.notices[0]?.kind, 'failed');
});

test('窗口不在前时,跑完才从进行中变成空闲/完成才报一声', () => {
  const prev = new Map([['local:a', 'running']]);
  const done = noticesFromSnapshot({
    primed: true, prev, next: [row({ key: 'local:a', status: 'idle' })],
    activeKey: 'local:a', windowFocused: false,
  });
  assert.equal(done.notices[0]?.kind, 'done');
  const stay = noticesFromSnapshot({
    primed: true, prev: new Map([['local:a', 'idle']]), next: [row({ key: 'local:a', status: 'idle' })],
    activeKey: null, windowFocused: false,
  });
  assert.equal(stay.notices.length, 0);
  const watching = noticesFromSnapshot({
    primed: true, prev, next: [row({ key: 'local:a', status: 'idle' })],
    activeKey: 'local:a', windowFocused: true,
  });
  assert.equal(watching.notices.length, 0);
});

test('通知路径能读出本机会话,带机器名的也能读', () => {
  assert.deepEqual(sessionPathTarget('/session/abc'), { machine: 'local', id: 'abc' });
  assert.deepEqual(sessionPathTarget('/session/fold:xyz'), { machine: 'fold', id: 'xyz' });
  assert.equal(sessionPathTarget('/home'), null);
});

test('2.0 壳接上了系统通知、角标和点开那条会话', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const desktop = readFileSync(fileURLToPath(new URL('./desktop-notice.ts', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  const preload = readFileSync(fileURLToPath(new URL('../../electron/preload.cjs', import.meta.url)), 'utf8');
  assert.match(app, /noticesFromSnapshot/);
  assert.match(app, /setDockNeedBadge/);
  assert.match(app, /showSessionNotice/);
  assert.match(app, /onSessionNoticeClick/);
  assert.match(app, /sessionPathTarget/);
  assert.match(desktop, /leocodeboxDesktopTools/);
  assert.match(desktop, /setRunningBadge/);
  assert.match(main, /leocodebox-desktop:notify/);
  assert.match(preload, /notify:/);
});
