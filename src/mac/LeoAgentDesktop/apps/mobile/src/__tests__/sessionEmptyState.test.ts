import { describe, expect, it } from 'vitest';
import {
  shouldSuppressEmptyMessageState,
  shouldSuppressRemoteListEmptyState,
} from '@/session/sessionEmptyState';

const base = {
  loading: false,
  showSyncingShell: false,
  messageCount: 0,
  hasSyncedThisOpen: false,
  remoteUnavailable: false,
};

describe('shouldSuppressEmptyMessageState', () => {
  it('suppresses the empty state on cold open before the first sync (0 msgs, not synced, online)', () => {
    // 冷开首帧:currentSession 立即有、消息未到、loading 还没翻 true → 抑制,渲染同步占位而非闪"暂无消息"。
    expect(shouldSuppressEmptyMessageState(base)).toBe(true);
  });

  it('shows the empty state once a sync completed and the session is genuinely empty', () => {
    // 真·空会话:同步完成过(lastSyncedAt 有值)且 0 条 → 不抑制,正常显示"暂无消息"。
    expect(shouldSuppressEmptyMessageState({ ...base, hasSyncedThisOpen: true })).toBe(false);
  });

  it('does not suppress when there is content', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, messageCount: 80 })).toBe(false);
    expect(shouldSuppressEmptyMessageState({ ...base, messageCount: 80, hasSyncedThisOpen: true })).toBe(false);
  });

  it('does not suppress when remote is unavailable (offline / revoked keeps the placeholder)', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, remoteUnavailable: true })).toBe(false);
  });

  it('suppresses while loading or showing the syncing shell regardless of other flags', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, loading: true, hasSyncedThisOpen: true })).toBe(true);
    expect(shouldSuppressEmptyMessageState({ ...base, showSyncingShell: true, hasSyncedThisOpen: true })).toBe(true);
    // loading 优先于离线占位:loading 期间本就在拉取,空状态仍抑制。
    expect(shouldSuppressEmptyMessageState({ ...base, loading: true, remoteUnavailable: true })).toBe(true);
  });
});

describe('shouldSuppressRemoteListEmptyState', () => {
  it('suppresses the empty state on cold open before the first sync completes (0 items, not synced)', () => {
    // 冷进首帧:列表初始 []、lastSyncedAt === null → 抑制,渲染干净空白而非闪"暂无自动化/还没有对话"。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 0, hasSyncedThisOpen: false })).toBe(true);
  });

  it('shows the empty state once a sync completed and the list is genuinely empty', () => {
    // 真·空列表:首同步完成过(lastSyncedAt 有值)且确实 0 条 → 不抑制,正常显示空状态插画。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 0, hasSyncedThisOpen: true })).toBe(false);
  });

  it('never suppresses when the list has content (store pre-seeded before the first sync)', () => {
    // 从首页带 store 数据进入:同步尚未完成但列表已有内容 → 空状态本就不渲染,判定恒为不抑制。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 3, hasSyncedThisOpen: false })).toBe(false);
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 3, hasSyncedThisOpen: true })).toBe(false);
  });
});
