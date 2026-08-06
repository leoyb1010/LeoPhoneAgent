/**
 * composerDraftAttachmentsRoundTrip.test.ts
 * ---------------------------------------------------------------------------
 * 回归 useAttachments × composerDraftStore 的"切走再切回"附件保活契约。
 *
 * 真实 bug:跨 session 切换时,A → B → A 后输入框附件丢失。根因是 ChatInput
 * 内部的 useAttachments(sessionId) 与 CCAgentSessionView 的 useAttachments(sessionId)
 * 同时往同一个 draft slot 写;父级 hook 持有真实 [files],ChatInput 的内部那
 * 份始终是 [],两者交叉写时存在 race window。修复:当 externalAttachments 存在
 * 时,ChatInput 把 sessionId=undefined 传给内部 hook,让它彻底变 no-op。
 *
 * 这里不引入 react-testing-library,直接验证 composerDraftStore 在两个 writer
 * 顺序写入时,只要"父级最后写入"约定不被破坏,attachments 就能往返。然后用
 * sessionId=undefined 模拟修复后的内部 hook,确认它不会触发任何写入。
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  saveDraft,
  getDraft,
  clearDraft,
} from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';

function makeAttachment(name: string): AttachedFile {
  return {
    id: `id-${name}`,
    name,
    path: `/tmp/${name}`,
    ext: '.png',
    size: 1234,
    category: 'image',
    mimeType: 'image/png',
    url: `xdt-image://A/${name}`,
    originalName: name,
  };
}

/**
 * 模拟 useAttachments 的 session-switch effect。返回新的 ref/prevId 状态,
 * 配合多个实例链式调用即可复现 child→parent 双 hook 顺序。
 */
function simulateSessionSwitchEffect(args: {
  sessionId: string | undefined;
  prevSessionId: string | undefined;
  attachmentsRefAtSaveTime: AttachedFile[];
}): { restored: AttachedFile[] | undefined; newPrev: string | undefined } {
  const { sessionId, prevSessionId, attachmentsRefAtSaveTime } = args;

  // Step 1: save prev draft (if there was one and it's not the same session).
  if (prevSessionId && prevSessionId !== sessionId) {
    const existing = getDraft(prevSessionId);
    saveDraft(prevSessionId, {
      text: existing?.text ?? null,
      attachments: attachmentsRefAtSaveTime,
    });
  }

  // Step 2: restore new session's attachments. b1e9827 守卫:首挂 (prevId === undefined)
  // 时跳过,避免无意义 setAttachments 触发重渲染。
  let restored: AttachedFile[] | undefined;
  if (
    sessionId !== undefined &&
    prevSessionId !== undefined &&
    prevSessionId !== sessionId
  ) {
    const draft = getDraft(sessionId);
    restored = draft?.attachments ?? [];
  }

  return { restored, newPrev: sessionId };
}

beforeEach(() => {
  clearDraft('A');
  clearDraft('B');
});

describe('composer draft attachments — A → B → A 往返', () => {
  it('单一 writer:父级单独负责 save/restore 时,附件能完整往返', () => {
    // 父级 hook 全程持有真实 attachments_P
    let parentRef: AttachedFile[] = [];
    let parentPrev: string | undefined = undefined;

    // ── 首次 mount A ──
    let r = simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = r.newPrev;
    expect(r.restored).toBeUndefined(); // 首挂不 restore

    // 用户拖入两张图
    const files = [makeAttachment('a1.png'), makeAttachment('a2.png')];
    parentRef = files;

    // ── 切到 B ──
    r = simulateSessionSwitchEffect({
      sessionId: 'B',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = r.newPrev;
    // restored 是 B 的 draft,初次访问应当是 [](无 saved draft)
    expect(r.restored).toEqual([]);
    parentRef = r.restored ?? [];

    // ── 切回 A ──
    r = simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = r.newPrev;
    expect(r.restored).toEqual(files);
  });

  it('双 writer (修复前):child 先写空数组、parent 后写真实数组,parent 应胜出', () => {
    // 这是修复前的真实情况:child 跑 effect 在 parent 之前。
    const childRef: AttachedFile[] = [];
    let childPrev: string | undefined = undefined;
    let parentRef: AttachedFile[] = [];
    let parentPrev: string | undefined = undefined;

    // 首次 mount
    simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef,
    });
    childPrev = 'A';
    simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = 'A';

    // 加附件
    const files = [makeAttachment('x.png')];
    parentRef = files;

    // 切到 B —— 注意 child 先跑、parent 后跑(React 子→父 effect 顺序)
    simulateSessionSwitchEffect({
      sessionId: 'B',
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef, // [] —— child 始终空
    });
    childPrev = 'B';
    const rP = simulateSessionSwitchEffect({
      sessionId: 'B',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef, // [files]
    });
    parentPrev = 'B';
    parentRef = rP.restored ?? [];

    // 切回 A —— 同样 child 先 / parent 后
    simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef,
    });
    childPrev = 'A';
    const rPBack = simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = 'A';

    // ✅ 即便 child 在中间过程清过一次,parent 后写覆盖回 [files],切回后能恢复
    expect(rPBack.restored).toEqual(files);
  });

  it('修复后:child 用 sessionId=undefined,完全不参与 save/restore', () => {
    // 修复:ChatInput 把 sessionId=undefined 传给内部 hook
    const childRef: AttachedFile[] = [];
    let childPrev: string | undefined = undefined;
    let parentRef: AttachedFile[] = [];
    let parentPrev: string | undefined = undefined;

    // ── 首次 mount,父 sessionId=A,child sessionId=undefined ──
    simulateSessionSwitchEffect({
      sessionId: undefined,
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef,
    });
    childPrev = undefined; // sessionId=undefined → previousSessionIdRef 一直保持 undefined
    simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = 'A';

    // 加附件(走父级)
    const files = [makeAttachment('y.png')];
    parentRef = files;

    // 切到 B
    simulateSessionSwitchEffect({
      sessionId: undefined,
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef,
    });
    // child 仍然 sessionId=undefined (修复后内部 hook 永远 undefined),不会 save/restore
    expect(getDraft('A')).toBeUndefined(); // 父还没跑,A 应当还没被 save

    const rP = simulateSessionSwitchEffect({
      sessionId: 'B',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    parentPrev = 'B';
    parentRef = rP.restored ?? [];
    // 此时 A 的 draft 应当是 parent 写的 [files]
    expect(getDraft('A')?.attachments).toEqual(files);

    // 切回 A
    simulateSessionSwitchEffect({
      sessionId: undefined,
      prevSessionId: childPrev,
      attachmentsRefAtSaveTime: childRef,
    });
    const rPBack = simulateSessionSwitchEffect({
      sessionId: 'A',
      prevSessionId: parentPrev,
      attachmentsRefAtSaveTime: parentRef,
    });
    expect(rPBack.restored).toEqual(files);
  });

  it('FadeSwitcher 重挂路径:旧实例 cleanup 必须把附件落盘,新实例 mount 必须能 restore', () => {
    // 真实 bug: MainLayout 用 <FadeSwitcher key={location.pathname}> 包 Outlet,
    // 切换 session 会销毁旧 CCAgentSessionView 实例并挂新实例。旧实例的 useAttachments
    // 还没等到"sessionId 变了的渲染"就死了 —— 没有 in-effect save 能跑;附件只在
    // React state 里、从未落盘。修复:cleanup 函数把当前 attachments 落到当前
    // sessionId 的 draft slot;mount 时 restore 即使 prevId 是 undefined 也读一次。
    function simulateMount(sessionId: string): { setAttachments: (a: AttachedFile[]) => void; cleanup: () => void } {
      let current: AttachedFile[] = [];
      const restored = getDraft(sessionId);
      if (restored?.attachments && restored.attachments.length > 0) {
        current = restored.attachments;
      }
      return {
        setAttachments: (a) => { current = a; },
        cleanup: () => {
          const existing = getDraft(sessionId);
          saveDraft(sessionId, {
            text: existing?.text ?? null,
            attachments: current,
          });
        },
      };
    }

    // ── Mount A,拖入文件,然后被 FadeSwitcher 销毁 ──
    const aInst1 = simulateMount('A');
    const files = [makeAttachment('drop.png')];
    aInst1.setAttachments(files);
    aInst1.cleanup(); // FadeSwitcher 销毁旧实例

    // ── Mount B(新实例),没附件 ──
    const bInst = simulateMount('B');
    expect(getDraft('A')?.attachments).toEqual(files); // A 已落盘
    bInst.cleanup();

    // ── Mount A 第二次(新实例,fresh state)──
    const aInst2 = simulateMount('A');
    // restore 应当从 store 恢复 [drop.png]。我们没法直接读 aInst2.current,
    // 但可以验证 restore 路径会读到正确数据。
    const restored = getDraft('A');
    expect(restored?.attachments).toEqual(files);
    aInst2.cleanup();
  });

  it('save 时保留 existing.text 不被 attachments writer 抹掉', () => {
    // ChatInput 的 onUpdate 已经把 text 写进 draft;useAttachments 切换时
    // 必须读 existing.text 透传,不能用 null 覆盖。
    saveDraft('A', { text: { type: 'doc', content: [] } as never, attachments: [] });

    const parentRef: AttachedFile[] = [makeAttachment('z.png')];
    simulateSessionSwitchEffect({
      sessionId: 'B',
      prevSessionId: 'A',
      attachmentsRefAtSaveTime: parentRef,
    });

    const after = getDraft('A');
    expect(after?.text).not.toBeNull(); // text 应当保留
    expect(after?.attachments).toEqual(parentRef);
  });
});
