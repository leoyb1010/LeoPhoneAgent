import test from 'node:test';
import assert from 'node:assert/strict';

import { decideSessionProviderSync } from './sessionProviderSync';

const base = {
  syncedSessionId: 'session-claude' as string | null,
  sessionId: 'session-claude' as string | null,
  sessionProvider: 'claude' as string | null,
  provider: 'claude',
};

test('停在同一个会话上时,用户刚选的 Agent 不许被会话按回去', () => {
  // 这就是 bug A 的那一刻:指挥条把 provider 换成 codex,会话没换。
  assert.equal(decideSessionProviderSync({ ...base, provider: 'codex' }), 'keep');
});

test('会话对象被列表刷新重建、id 没变,同样不能覆盖用户的选择', () => {
  // projects 定时静默刷新会重建 session 对象,effect 因此重跑 —— 判据只看 id。
  assert.equal(decideSessionProviderSync({ ...base, provider: 'grok' }), 'keep');
});

test('换到另一个已有会话时跟随该会话的 provider', () => {
  assert.equal(
    decideSessionProviderSync({
      syncedSessionId: 'session-claude',
      sessionId: 'session-codex',
      sessionProvider: 'codex',
      provider: 'claude',
    }),
    'follow',
  );
});

test('开新会话(没有选中会话)时保留用户选的 Agent,只记录会话已换', () => {
  assert.equal(
    decideSessionProviderSync({
      syncedSessionId: 'session-claude',
      sessionId: null,
      sessionProvider: null,
      provider: 'codex',
    }),
    'track',
  );
});

test('换了会话但 provider 本来就一致,不必再 setState', () => {
  assert.equal(
    decideSessionProviderSync({
      syncedSessionId: 'a',
      sessionId: 'b',
      sessionProvider: 'codex',
      provider: 'codex',
    }),
    'track',
  );
});

test('首次挂载在某个会话上(还没跟随过)会跟随它', () => {
  assert.equal(
    decideSessionProviderSync({
      syncedSessionId: null,
      sessionId: 'session-codex',
      sessionProvider: 'codex',
      provider: 'claude',
    }),
    'follow',
  );
});
