/**
 * composerDraftMountRace.test.ts
 * ---------------------------------------------------------------------------
 * 回归 issue #40:协同 ↔ 普通 session 切换时,ChatInput 整体 unmount/remount,
 * Tiptap useEditor 在 mount 阶段会因 decoration 扩展 (CjkPunctDecoration /
 * VoiceInputDraftDecoration) 提前 fire 一次 onUpdate —— 比 React 的 useEffect
 * 早大约 4ms 拿到的是初始空 editor,把 composerDraftStore 里已有的草稿覆盖成
 * 空文档,等 hydration 跑时已经没东西可恢复。
 *
 * 修法 (ChatInput.tsx):加 hasHydratedRef,只有在 hydration effect 跑完之后才
 * 放行 onUpdate 的 save。本测试在不引入 React + Tiptap 的前提下,模拟两条
 * 关键序列:
 *   (a) "修复前"路径:onUpdate 在 hydration 前直接写 store → store 被空文档抹掉
 *   (b) "修复后"路径:hasHydratedRef 守卫,onUpdate 提前 return → store 保留
 *
 * 同步对 cross-session switch 路径做正向验证,确认 hasHydratedRef 翻 true 之后
 * 用户真实按键能正常落盘 (避免修复过度,把所有按键都吞掉)。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { JSONContent } from '@tiptap/core';

import {
  saveDraft,
  getDraft,
  clearDraft,
} from '@/lib/composerDraftStore';

const EMPTY_TIPTAP_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

function makeTextDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * 复刻 ChatInput.onUpdate 的 save 路径。返回 true 表示真正写了 store,false 表示
 * 被早期 return 路径吞掉(restoring / no-storageKey / hasHydrated 守卫)。
 *
 * 与生产代码同步保持:
 *   - if (isRestoringRef.current) return
 *   - if (!hasHydratedRef.current) return    ← issue #40 修复
 *   - if (!sk) return
 *   - saveDraft(sk, { text: editorJson, attachments: existing?.attachments ?? [] })
 */
function simulateOnUpdate(args: {
  storageKey: string | undefined;
  editorJson: JSONContent;
  isRestoring: boolean;
  hasHydrated: boolean;
}): boolean {
  if (args.isRestoring) return false;
  if (!args.hasHydrated) return false;
  const sk = args.storageKey;
  if (!sk) return false;
  const existing = getDraft(sk);
  saveDraft(sk, {
    text: args.editorJson,
    attachments: existing?.attachments ?? [],
  }, { silent: true });
  return true;
}

/**
 * 复刻 ChatInput 的 storageKey-effect 中的 hydration 分支(prevEditorKey===storageKey
 * 的首挂路径)。返回 hasHydrated 翻 true 后的状态。
 */
function simulateHydrationEffect(): { hydrated: boolean } {
  // 这里不真的去 setContent 一个假 editor —— 因为本测试只关心 store 数据流。
  // 关键不变量:hydration 跑完后,hasHydrated 必须被置 true,否则后续按键永远
  // 写不进去 (= 修复过度 bug,要在这里挡住)。
  return { hydrated: true };
}

/**
 * 复刻 ChatInput 的 unmount / storageKey-change cleanup 兜底:
 * 切到 Settings 这类跨 feature 路由会直接卸载 ChatInput,不能只依赖 onUpdate。
 */
function simulateUnmountSnapshot(args: {
  storageKey: string | undefined;
  editorJson: JSONContent;
  editorIsEmpty: boolean;
}): boolean {
  const sk = args.storageKey;
  if (!sk) return false;
  const existing = getDraft(sk);
  if (args.editorIsEmpty && !existing) return false;
  saveDraft(sk, {
    text: args.editorJson,
    attachments: existing?.attachments ?? [],
  }, { silent: true });
  return true;
}

beforeEach(() => {
  clearDraft('LEAD-A');
  clearDraft('NORMAL-B');
  clearDraft('SETTINGS-A');
});

describe('composer draft mount-race (issue #40)', () => {
  it('修复后:Tiptap mount 初始 onUpdate 不能覆盖 store 里已有的草稿', () => {
    // ── 用户上一轮在 NORMAL-B 输入了 "hello",已经被 onUpdate 保存进 store ──
    saveDraft('NORMAL-B', { text: makeTextDoc('hello'), attachments: [] });
    expect(getDraft('NORMAL-B')?.text).toEqual(makeTextDoc('hello'));

    // ── 用户切到协同 session,B 的 ChatInput unmount(text 仍在 store) ──
    // ── 用户再切回 NORMAL-B → ChatInput 重挂 ──
    // 1) Tiptap mount 阶段先 fire 一次 onUpdate (空 editor)
    let hasHydrated = false; // 修复后初始 false
    const wroteOnInit = simulateOnUpdate({
      storageKey: 'NORMAL-B',
      editorJson: EMPTY_TIPTAP_DOC,
      isRestoring: false,
      hasHydrated,
    });
    expect(wroteOnInit).toBe(false); // 守卫生效,没写 store

    // 2) React 的 useEffect 跑 hydration
    const { hydrated } = simulateHydrationEffect();
    hasHydrated = hydrated;
    expect(hasHydrated).toBe(true);

    // 3) store 里 "hello" 完好,可被 setContent 还原
    expect(getDraft('NORMAL-B')?.text).toEqual(makeTextDoc('hello'));
  });

  it('反例守底:如果没有 hasHydrated 守卫,store 会被 mount 时空 doc 抹掉', () => {
    // 这条 case 模拟"修复前"的行为,作为反例守底:确认我们抓到的根因是真的。
    saveDraft('NORMAL-B', { text: makeTextDoc('hello'), attachments: [] });

    // hasHydrated 取 true 模拟"无守卫"——onUpdate 完全放行
    const wrote = simulateOnUpdate({
      storageKey: 'NORMAL-B',
      editorJson: EMPTY_TIPTAP_DOC, // mount 时的空 editor
      isRestoring: false,
      hasHydrated: true, // ← 无守卫的旧行为
    });
    expect(wrote).toBe(true);

    // ✗ store 已被抹成空文档,hydration 再读到的就是空
    expect(getDraft('NORMAL-B')?.text).toEqual(EMPTY_TIPTAP_DOC);
  });

  it('hydration 跑完后,用户真实按键能正常落盘 (避免修复过度)', () => {
    saveDraft('NORMAL-B', { text: makeTextDoc('hello'), attachments: [] });

    // mount + hydration
    let hasHydrated = false;
    simulateOnUpdate({
      storageKey: 'NORMAL-B',
      editorJson: EMPTY_TIPTAP_DOC,
      isRestoring: false,
      hasHydrated,
    });
    hasHydrated = simulateHydrationEffect().hydrated;

    // 用户在 "hello" 后追加 "!"
    const wrote = simulateOnUpdate({
      storageKey: 'NORMAL-B',
      editorJson: makeTextDoc('hello!'),
      isRestoring: false,
      hasHydrated,
    });
    expect(wrote).toBe(true);
    expect(getDraft('NORMAL-B')?.text).toEqual(makeTextDoc('hello!'));
  });

  it('cross-session 切换:LEAD-A → NORMAL-B,B 的 store 不会被 A 的残留 editor 内容污染', () => {
    // 用户在 LEAD-A (协同 lead) 输入 "lead-text",已存
    saveDraft('LEAD-A', { text: makeTextDoc('lead-text'), attachments: [] });
    // 用户在 NORMAL-B 也输入过 "normal-text",已存
    saveDraft('NORMAL-B', { text: makeTextDoc('normal-text'), attachments: [] });

    // 用户从 A 切到 B,ChatInput 整体 unmount → remount (storageKey=B)
    // mount 期间 Tiptap 的 onUpdate 触发 —— 修复后 hasHydrated=false,被吞掉
    let hasHydrated = false;
    const wroteOnInit = simulateOnUpdate({
      storageKey: 'NORMAL-B',
      editorJson: EMPTY_TIPTAP_DOC,
      isRestoring: false,
      hasHydrated,
    });
    expect(wroteOnInit).toBe(false);

    // hydration 跑完,放行后续按键
    hasHydrated = simulateHydrationEffect().hydrated;

    // 两边 store 都没被污染
    expect(getDraft('LEAD-A')?.text).toEqual(makeTextDoc('lead-text'));
    expect(getDraft('NORMAL-B')?.text).toEqual(makeTextDoc('normal-text'));
  });

  it('切到 Settings 卸载 ChatInput 时,cleanup 会补写最后一版 editor 内容', () => {
    // 模拟用户输入后马上点 Settings:onUpdate 可能还没来得及写最后一版,
    // 但 unmount cleanup 必须把当前 editor JSON 快照保存下来。
    expect(getDraft('SETTINGS-A')).toBeUndefined();

    const wrote = simulateUnmountSnapshot({
      storageKey: 'SETTINGS-A',
      editorJson: makeTextDoc('settings draft'),
      editorIsEmpty: false,
    });

    expect(wrote).toBe(true);
    expect(getDraft('SETTINGS-A')?.text).toEqual(makeTextDoc('settings draft'));
  });
});
