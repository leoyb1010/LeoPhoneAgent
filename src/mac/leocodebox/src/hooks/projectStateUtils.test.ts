import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../types/app';

import {
  mergeExpandedSessionPages,
  mergeProjectSessionPage,
  isValidTab,
  persistHandoffSource,
  readHandoffSource,
  readPersistedTab,
  removeSessionFromProject,
  upsertSessionIntoProject,
  type SessionUpsertedEvent,
} from './projectStateUtils';

test('retired top-level workspaces are no longer valid tabs', () => {
  // 只剩 missions 是真退役的(快速任务搬进了 ⌘K)。fleet 曾一起被列进来,但它
  // 其实**还是**页签栏里的「Mac 控制台」(MainContentTabSwitcher 无条件渲染
  // FLEET_TAB,MainContent 也照常渲染 FleetView)—— 当成退役的后果是:能点、
  // 能用,一重启就被判非法、默默弹回聊天。清单以页签栏为准。
  assert.equal(isValidTab('missions'), false, 'missions should be retired');
  assert.equal(isValidTab('chat'), true);
  assert.equal(isValidTab('fleet'), true, 'Mac 控制台仍在页签栏里');
  assert.equal(isValidTab('audit'), true, '会话审计仍在页签栏里');
  assert.equal(isValidTab('dashboard'), true, '主控台是「选 Agent 开新任务」的落点,必须合法');
});

// Minimal in-memory localStorage for the handoff-map helpers (Node has none).
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}
const installLocalStorage = () => {
  const storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;
  return storage;
};

test('an install parked on a retired tab lands on the console', () => {
  const storage = installLocalStorage();
  storage.setItem('console-landing-seen', '1');
  storage.setItem('activeTab', 'missions');
  assert.equal(readPersistedTab(), 'dashboard');
  // 迁移是一次性的:陈旧的值被清掉,不会每次启动都重算。
  assert.equal(storage.getItem('activeTab'), null);

  storage.setItem('activeTab', 'files');
  assert.equal(readPersistedTab(), 'files');
});

test('升级后的第一次启动强制落在主控台一次', () => {
  // 老装机的 activeTab 全停在 'chat';不迁移一次,恢复回来的主控台谁也看不见。
  const storage = installLocalStorage();
  storage.setItem('activeTab', 'chat');
  assert.equal(readPersistedTab(), 'dashboard');
  // 只强制一次:标记落下之后就照旧尊重用户上次停的地方。
  assert.equal(readPersistedTab(), 'chat');
});

test('冷启动落在主控台,而不是某个会话', () => {
  // 「换 Agent」必须发生在一个还没绑定 Agent 的地方。一开机就落进会话,等于把
  // 每一次 Agent 切换都推回"在已有会话里改还是开新的?"那个歧义里 —— 三轮没根治的
  // 「选了 Codex 发出去还是 Claude」就长在这块土壤上。
  const storage = installLocalStorage();
  storage.clear();
  assert.equal(readPersistedTab(), 'dashboard');
  // 全新装机同样只走一次迁移,之后没有 activeTab 记录时的默认值仍是主控台。
  assert.equal(readPersistedTab(), 'dashboard');
});

test('上次停在主控台,下次打开还在主控台', () => {
  const storage = installLocalStorage();
  storage.setItem('console-landing-seen', '1');
  storage.setItem('activeTab', 'dashboard');
  assert.equal(readPersistedTab(), 'dashboard');
  assert.equal(storage.getItem('activeTab'), 'dashboard', '合法页签不该被迁移逻辑清掉');
});

const project = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'Project 1',
  isStarred: false,
  sessions: [],
  sessionMeta: { total: 0, hasMore: false },
  providerCounts: {},
  ...overrides,
});

test('upserting a new session prepends it and updates total/provider counts', () => {
  const next = upsertSessionIntoProject(project(), {
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    providerSessionId: 'provider-session-1',
    provider: 'codex',
    session: { id: 'provider-session-1', summary: 'Hello' },
    project: null,
  } as SessionUpsertedEvent);

  assert.equal(next.sessions?.[0]?.id, 'app-session-1');
  assert.equal(next.sessions?.[0]?.__provider, 'codex');
  assert.equal(next.sessionMeta?.total, 1);
  assert.deepEqual(next.providerCounts, { codex: 1 });
});

test('upserting by a provider alias preserves a non-empty existing title', () => {
  const original = project({
    sessions: [{ id: 'provider-session-1', summary: 'Existing title', __provider: 'claude' }],
    sessionMeta: { total: 1, hasMore: false },
  });
  const next = upsertSessionIntoProject(original, {
    kind: 'session_upserted',
    sessionId: 'app-session-1',
    providerSessionId: 'provider-session-1',
    provider: 'claude',
    session: { id: 'app-session-1', summary: '' },
    project: null,
  } as SessionUpsertedEvent);

  assert.equal(next.sessions?.length, 1);
  assert.equal(next.sessions?.[0]?.id, 'app-session-1');
  assert.equal(next.sessions?.[0]?.summary, 'Existing title');
  assert.equal(next.sessionMeta?.total, 1);
});

test('expanded project pages survive refresh and additional pages deduplicate sessions', () => {
  const previous = project({
    sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    sessionMeta: { total: 4, hasMore: true },
  });
  const refreshed = project({
    sessions: [{ id: 's1' }],
    sessionMeta: { total: 4, hasMore: true },
  });

  const [merged] = mergeExpandedSessionPages([previous], [refreshed]);
  assert.deepEqual(merged.sessions?.map((session) => session.id), ['s1', 's2', 's3']);

  const paged = mergeProjectSessionPage(merged, {
    sessions: [{ id: 's3' }, { id: 's4' }],
    sessionMeta: { total: 4, hasMore: false },
  });
  assert.deepEqual(paged.sessions?.map((session) => session.id), ['s1', 's2', 's3', 's4']);
  assert.equal(paged.sessionMeta?.hasMore, false);
});

test('removing a session updates pagination metadata without changing misses', () => {
  const original = project({
    sessions: [{ id: 's1' }, { id: 's2' }],
    sessionMeta: { total: 3, hasMore: true },
  });
  assert.equal(removeSessionFromProject(original, 'missing'), original);

  const next = removeSessionFromProject(original, 's1');
  assert.deepEqual(next.sessions?.map((session) => session.id), ['s2']);
  assert.deepEqual(next.sessionMeta, { total: 2, hasMore: true });
});

test('persistHandoffSource round-trips and readHandoffSource retrieves the source', () => {
  installLocalStorage();
  persistHandoffSource('new-session', 'source-session');
  assert.equal(readHandoffSource('new-session'), 'source-session');
  assert.equal(readHandoffSource('unknown-session'), null);
});

test('multiple handoff mappings coexist without overwriting each other', () => {
  installLocalStorage();
  persistHandoffSource('new-a', 'src-a');
  persistHandoffSource('new-b', 'src-b');
  assert.equal(readHandoffSource('new-a'), 'src-a');
  assert.equal(readHandoffSource('new-b'), 'src-b');
});

test('persistHandoffSource with null clears just that mapping', () => {
  installLocalStorage();
  persistHandoffSource('new-a', 'src-a');
  persistHandoffSource('new-b', 'src-b');
  persistHandoffSource('new-a', null);
  assert.equal(readHandoffSource('new-a'), null);
  assert.equal(readHandoffSource('new-b'), 'src-b');
});

test('readHandoffSource returns null on corrupt JSON without throwing', () => {
  const storage = installLocalStorage();
  storage.setItem('handoff-source-map', '{not json');
  assert.equal(readHandoffSource('anything'), null);
});

test('handoff map does not collide with the last-session key', () => {
  const storage = installLocalStorage();
  storage.setItem('last-session-id', 'ls-1');
  persistHandoffSource('new-a', 'src-a');
  assert.equal(storage.getItem('last-session-id'), 'ls-1');
  assert.equal(readHandoffSource('new-a'), 'src-a');
});
