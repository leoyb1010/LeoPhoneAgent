import { describe, expect, it } from 'vitest';

import { createDefaultLayout, validateLayout } from '../../../shared/layoutTree';
import { makeRootSwappedLayout } from '../layoutDevTools';

describe('makeRootSwappedLayout', () => {
  it('默认树:children 反转,结果仍是合法树,原树不被修改', () => {
    const layout = createDefaultLayout();
    const swapped = makeRootSwappedLayout(layout);
    expect(swapped).not.toBeNull();
    const kinds = (swapped!.content as { children: { node: { panelKind: string } }[] }).children.map(
      (c) => c.node.panelKind,
    );
    expect(kinds).toEqual(['right-tabs', 'chat-main']);
    expect(validateLayout(swapped!)).toEqual({ ok: true });
    // 原树保持默认顺序(immutable)。
    const originalKinds = (layout.content as { children: { node: { panelKind: string } }[] }).children.map(
      (c) => c.node.panelKind,
    );
    expect(originalKinds).toEqual(['chat-main', 'right-tabs']);
  });

  it('交换两次回到原顺序(round-trip)', () => {
    const layout = createDefaultLayout();
    const twice = makeRootSwappedLayout(makeRootSwappedLayout(layout)!);
    expect(twice).toEqual(layout);
  });

  it('content 为单 pane 时不可交换,返回 null', () => {
    const layout = createDefaultLayout();
    (layout as { content: unknown }).content = {
      type: 'pane',
      id: 'chat',
      panelKind: 'chat-main',
      minWidth: 400,
    };
    expect(makeRootSwappedLayout(layout)).toBeNull();
  });
});
