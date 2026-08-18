import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_INTENT_EVENT,
  announceAgentIntent,
  commitAgentForNewSession,
  resolveCommandBarAgent,
} from './agentIntent';

type Dispatched = { type: string; detail: unknown };

function withFakeWindow(run: () => void): Dispatched[] {
  const seen: Dispatched[] = [];
  const globals = globalThis as unknown as { window?: unknown; CustomEvent?: unknown };
  const previousWindow = globals.window;
  const previousCustomEvent = globals.CustomEvent;
  class FakeCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  globals.CustomEvent = FakeCustomEvent;
  globals.window = {
    dispatchEvent: (event: FakeCustomEvent) => {
      seen.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  try {
    run();
  } finally {
    globals.window = previousWindow;
    globals.CustomEvent = previousCustomEvent;
  }
  return seen;
}

test('宣告的事件名必须是会话侧真正监听的那一条', () => {
  // 换了名字就等于"选了 Agent 但没人听见" —— bug A 的形状。
  assert.equal(AGENT_INTENT_EVENT, 'leocodebox-preferences:changed');
});

test('宣告带上 provider,会话侧据此建新会话', () => {
  const seen = withFakeWindow(() => announceAgentIntent('codex'));
  assert.deepEqual(seen, [{
    type: 'leocodebox-preferences:changed',
    detail: { defaultProvider: 'codex' },
  }]);
});

test('给了推理强度就一起带上,漏了则不写进 detail', () => {
  assert.deepEqual(
    withFakeWindow(() => announceAgentIntent('claude', 'high'))[0].detail,
    { defaultProvider: 'claude', effort: 'high' },
  );
  assert.equal(
    (withFakeWindow(() => announceAgentIntent('claude', ''))[0].detail as Record<string, unknown>).effort,
    undefined,
  );
});

test('provider 为空时什么都不发,别把会话侧的选择清成空', () => {
  assert.deepEqual(withFakeWindow(() => announceAgentIntent('')), []);
});

test('停在已有会话上时,芯片显示的是这个会话的 Agent,而且改不了', () => {
  // 用户在主控台选了 Codex,然后点进一个 Claude 会话:芯片必须说实话(Claude),
  // 而不是继续显示 Codex —— 后者正是「选了 Codex 发出去还是 Claude」的观感来源。
  assert.deepEqual(
    resolveCommandBarAgent({ sessionProvider: 'claude', preferredProvider: 'codex' }),
    { provider: 'claude', locked: true },
  );
});

test('没有选中会话(主控台 / 新会话)时才是选择器,选的是下一个新会话用谁', () => {
  assert.deepEqual(
    resolveCommandBarAgent({ sessionProvider: null, preferredProvider: 'codex' }),
    { provider: 'codex', locked: false },
  );
  assert.deepEqual(
    resolveCommandBarAgent({ preferredProvider: 'grok' }),
    { provider: 'grok', locked: false },
  );
});

test('会话的 provider 是空字符串时按"没有绑定"处理,不要锁成空 Agent', () => {
  assert.deepEqual(
    resolveCommandBarAgent({ sessionProvider: '   ', preferredProvider: 'claude' }),
    { provider: 'claude', locked: false },
  );
});

test('主控台按下开始时,选择同时落到"挂载时读的那把钥匙"上', () => {
  // 主控台上 ChatInterface 没挂载,光发事件等于没人听见 —— 必须写 selected-provider,
  // 否则切回会话那一刻 provider 会用默认值重新初始化。
  const globals = globalThis as unknown as { localStorage?: unknown };
  const previous = globals.localStorage;
  const store = new Map<string, string>();
  globals.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    const seen = withFakeWindow(() => commitAgentForNewSession('codex'));
    assert.equal(store.get('selected-provider'), 'codex');
    assert.deepEqual(seen, [{
      type: 'leocodebox-preferences:changed',
      detail: { defaultProvider: 'codex' },
    }]);
  } finally {
    globals.localStorage = previous;
  }
});

test('没有 localStorage 时不炸,事件那条路照常走', () => {
  const globals = globalThis as unknown as { localStorage?: unknown };
  const previous = globals.localStorage;
  delete globals.localStorage;
  try {
    assert.deepEqual(
      withFakeWindow(() => commitAgentForNewSession('claude'))[0].detail,
      { defaultProvider: 'claude' },
    );
  } finally {
    globals.localStorage = previous;
  }
});
