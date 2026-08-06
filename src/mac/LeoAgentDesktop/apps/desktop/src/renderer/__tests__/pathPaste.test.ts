// @vitest-environment jsdom
// (upgradePastedPathsToChips 经 editor.view.dispatch 替换节点,需要 DOM。)
import { Editor, type JSONContent } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { MentionChipNode } from '@/components/new-chat/MentionChipNode';
import {
  upgradePastedPathsToChips,
  type PathStatKind,
  type PendingPathRange,
} from '@/components/new-chat/pathPaste';

const WORKDIR = '/Users/alice/Code/Tools/xdt-maker';

// Editor 必须逐个 destroy:EditorView 的异步回调会在 jsdom 环境拆除后触发
// `document is not defined` 未处理异常,vitest 全绿也会 exit 1(CI 实撞)。
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor(text: string): Editor {
  const content: JSONContent = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: text.length > 0 ? [{ type: 'text', text }] : [] },
    ],
  };
  const editor = new Editor({ extensions: [Document, Paragraph, Text, MentionChipNode], content });
  editors.push(editor);
  return editor;
}

/** 单段落文档里,字符偏移 `idx` 对应的 ProseMirror 位置(段落起点 = 1)。 */
function rangeFor(text: string, sub: string): PendingPathRange {
  const idx = text.indexOf(sub);
  if (idx < 0) throw new Error(`sub not found: ${sub}`);
  return { absPath: sub, from: 1 + idx, to: 1 + idx + sub.length };
}

/** fire-and-forget 的 stat promise 链落定(microtask flush)。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function inlineOf(editor: Editor): Array<{ type?: string; text?: string; attrs?: unknown }> {
  return (editor.getJSON().content?.[0]?.content ?? []) as Array<{
    type?: string;
    text?: string;
    attrs?: unknown;
  }>;
}

describe('upgradePastedPathsToChips', () => {
  it('replaces the recorded range in place with an @file chip', async () => {
    const abs = `${WORKDIR}/apps/desktop/src/main.ts`;
    const doc = `报错在 ${abs} 一行`;
    const editor = makeEditor(doc);
    upgradePastedPathsToChips(
      editor, [rangeFor(doc, abs)], WORKDIR, {}, async () => 'file' as PathStatKind,
    );
    await flush();
    expect(inlineOf(editor)).toEqual([
      { type: 'text', text: '报错在 ' },
      {
        type: 'mentionChip',
        attrs: {
          kind: 'file',
          label: 'main.ts',
          path: 'apps/desktop/src/main.ts',
          titled: false,
        },
      },
      { type: 'text', text: ' 一行' },
    ]);
  });

  it('uses a dir chip when stat reports a directory', async () => {
    const abs = `${WORKDIR}/apps/desktop`;
    const editor = makeEditor(abs);
    upgradePastedPathsToChips(
      editor, [rangeFor(abs, abs)], WORKDIR, {}, async () => 'dir' as PathStatKind,
    );
    await flush();
    const inline = inlineOf(editor);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({
      type: 'mentionChip',
      attrs: { kind: 'dir', label: 'desktop', path: 'apps/desktop' },
    });
  });

  it('keeps plain text when the path is missing', async () => {
    const abs = `${WORKDIR}/gone.ts`;
    const editor = makeEditor(abs);
    upgradePastedPathsToChips(
      editor, [rangeFor(abs, abs)], WORKDIR, {}, async () => 'missing' as PathStatKind,
    );
    await flush();
    expect(inlineOf(editor)).toEqual([{ type: 'text', text: abs }]);
  });

  it('gives up when the user edited the range before stat resolved', async () => {
    const abs = `${WORKDIR}/src/index.ts`;
    const editor = makeEditor(abs);
    let resolveStat: (kind: PathStatKind) => void = () => {};
    const statPromise = new Promise<PathStatKind>((resolve) => {
      resolveStat = resolve;
    });
    upgradePastedPathsToChips(editor, [rangeFor(abs, abs)], WORKDIR, {}, () => statPromise);
    // stat 落定前用户改了文本 → 映射后区间文本不再等于原路径 → 放弃升级
    editor.commands.setContent(`${WORKDIR}/src/index-renamed.ts`);
    resolveStat('file');
    await flush();
    expect(inlineOf(editor)).toEqual([
      { type: 'text', text: `${WORKDIR}/src/index-renamed.ts` },
    ]);
  });

  it('does not touch identical text outside the recorded range (review P1)', async () => {
    const abs = `${WORKDIR}/a.ts`;
    // 文档里同一路径出现两次,但只有第一次是本次粘贴落地的 range。
    const doc = `${abs} 与手敲的 ${abs}`;
    const editor = makeEditor(doc);
    upgradePastedPathsToChips(
      editor, [{ absPath: abs, from: 1, to: 1 + abs.length }], WORKDIR, {},
      async () => 'file' as PathStatKind,
    );
    await flush();
    const inline = inlineOf(editor);
    expect(inline[0]).toMatchObject({ type: 'mentionChip' });
    // 第二次出现保持纯文本
    expect(inline[inline.length - 1]).toEqual({ type: 'text', text: ` 与手敲的 ${abs}` });
  });

  it('upgrades prefix-sibling paths independently without corruption (review P1)', async () => {
    const short = `${WORKDIR}/a.ts`;
    const long = `${WORKDIR}/a.ts.bak`;
    const doc = `见 ${short} 和 ${long}`;
    const editor = makeEditor(doc);
    upgradePastedPathsToChips(
      editor,
      [rangeFor(doc, short), { absPath: long, from: 1 + doc.indexOf(long), to: 1 + doc.indexOf(long) + long.length }],
      WORKDIR,
      {},
      async () => 'file' as PathStatKind,
    );
    await flush();
    const inline = inlineOf(editor);
    const chips = inline.filter((n) => n.type === 'mentionChip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({ attrs: { path: 'a.ts' } });
    expect(chips[1]).toMatchObject({ attrs: { path: 'a.ts.bak' } });
    // 长路径没有被短路径的替换切坏(不存在残留的 `.bak` 裸文本粘在 chip 后)
    expect(inline.some((n) => n.type === 'text' && n.text === '.bak')).toBe(false);
  });

  it('maps later ranges through earlier replacements (multiple ranges settle in order)', async () => {
    const abs = `${WORKDIR}/a.ts`;
    const doc = `${abs} 与 ${abs}`;
    const editor = makeEditor(doc);
    const second = 1 + doc.lastIndexOf(abs);
    upgradePastedPathsToChips(
      editor,
      [
        { absPath: abs, from: 1, to: 1 + abs.length },
        { absPath: abs, from: second, to: second + abs.length },
      ],
      WORKDIR,
      {},
      async () => 'file' as PathStatKind,
    );
    await flush();
    // 第一处替换让文档变短,第二个 range 经 mapping 修正后仍精确命中。
    const chips = inlineOf(editor).filter((n) => n.type === 'mentionChip');
    expect(chips).toHaveLength(2);
  });
});
