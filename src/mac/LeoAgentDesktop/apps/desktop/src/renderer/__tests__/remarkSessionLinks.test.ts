import { describe, expect, it } from 'vitest';
import type { Root, Paragraph, PhrasingContent } from 'mdast';

import remarkSessionLinks from '../components/chat/remarkSessionLinks';

const SESSION_URL = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471';

function runOnText(value: string): PhrasingContent[] {
  const paragraph: Paragraph = { type: 'paragraph', children: [{ type: 'text', value }] };
  const tree: Root = { type: 'root', children: [paragraph] };
  const transform = (remarkSessionLinks as () => (tree: Root) => void)();
  transform(tree);
  return (tree.children[0] as Paragraph).children;
}

describe('remarkSessionLinks', () => {
  it('converts a bare session URL into a link node', () => {
    const children = runOnText(`见 ${SESSION_URL} 这条`);
    expect(children).toEqual([
      { type: 'text', value: '见 ' },
      { type: 'link', url: SESSION_URL, children: [{ type: 'text', value: SESSION_URL }] },
      { type: 'text', value: ' 这条' },
    ]);
  });

  it('keeps the message anchor and stops at CJK / trailing punctuation', () => {
    const withAnchor = `${SESSION_URL}?message=client-9`;
    const children = runOnText(`跳转:${withAnchor}。收尾`);
    expect(children[1]).toMatchObject({ type: 'link', url: withAnchor });
    expect(children[2]).toEqual({ type: 'text', value: '。收尾' });

    const trailing = runOnText(`see ${withAnchor}.`);
    expect(trailing[1]).toMatchObject({ type: 'link', url: withAnchor });
    expect(trailing[2]).toEqual({ type: 'text', value: '.' });
  });

  it('handles multiple URLs in one text node', () => {
    const children = runOnText(`${SESSION_URL} 和 ${SESSION_URL}`);
    expect(children.filter((node) => node.type === 'link')).toHaveLength(2);
  });

  it('leaves text inside existing links untouched', () => {
    const paragraph: Paragraph = {
      type: 'paragraph',
      children: [
        {
          type: 'link',
          url: SESSION_URL,
          children: [{ type: 'text', value: SESSION_URL }],
        },
      ],
    };
    const tree: Root = { type: 'root', children: [paragraph] };
    (remarkSessionLinks as () => (tree: Root) => void)()(tree);
    expect((tree.children[0] as Paragraph).children).toHaveLength(1);
    expect((tree.children[0] as Paragraph).children[0].type).toBe('link');
  });

  it('converts a bare project URL into a link node', () => {
    const projectUrl = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
    expect(runOnText(`项目 ${projectUrl} 在此`)).toEqual([
      { type: 'text', value: '项目 ' },
      { type: 'link', url: projectUrl, children: [{ type: 'text', value: projectUrl }] },
      { type: 'text', value: ' 在此' },
    ]);
  });

  it('leaves legacy project links with raw delimiters as plain text (review P2)', () => {
    // 旧编码放行 `'()`;白名单截断出的前缀链接会指错项目,整段维持纯文本。
    expect(runOnText('xdt-maker://project/%2Ftmp%2Ffoo(copy)')).toEqual([
      { type: 'text', value: 'xdt-maker://project/%2Ftmp%2Ffoo(copy)' },
    ]);
    expect(runOnText("xdt-maker://project/%2FJohn's%20Repo")).toEqual([
      { type: 'text', value: "xdt-maker://project/%2FJohn's%20Repo" },
    ]);
  });

  it('ignores unknown xdt-maker URL shapes and malformed ids', () => {
    expect(runOnText('xdt-maker://other/foo')).toEqual([
      { type: 'text', value: 'xdt-maker://other/foo' },
    ]);
    // 非法 % 序列解析不出 sessionId → 不切
    expect(runOnText('xdt-maker://session/%ZZ')).toEqual([
      { type: 'text', value: 'xdt-maker://session/%ZZ' },
    ]);
  });

  // 双 scheme 收敛:主 scheme cindy:// 链接与历史 xdt-maker://(上方全部用例)
  // 同一口径切 link 节点。
  it('converts primary-scheme cindy:// session and project URLs', () => {
    const cindySession = 'cindy://session/03e0c22d-19db-4ac5-814f-1ea04040b471';
    expect(runOnText(`见 ${cindySession}?message=m1。`)).toEqual([
      { type: 'text', value: '见 ' },
      {
        type: 'link',
        url: `${cindySession}?message=m1`,
        children: [{ type: 'text', value: `${cindySession}?message=m1` }],
      },
      { type: 'text', value: '。' },
    ]);
    const cindyProject = 'cindy://project/%2Ftmp%2Fx';
    expect(runOnText(cindyProject)).toEqual([
      { type: 'link', url: cindyProject, children: [{ type: 'text', value: cindyProject }] },
    ]);
    expect(runOnText('cindy://other/foo')).toEqual([
      { type: 'text', value: 'cindy://other/foo' },
    ]);
  });

  it('handles both schemes mixed in one text node', () => {
    const legacy = 'xdt-maker://session/aaa-111';
    const primary = 'cindy://session/bbb-222';
    const children = runOnText(`${legacy} 与 ${primary}`);
    expect(children.filter((node) => node.type === 'link').map((n) => (n as { url: string }).url))
      .toEqual([legacy, primary]);
  });
});
