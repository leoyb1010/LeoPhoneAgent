/**
 * rehypeMathBlockMarker — 给块级 KaTeX 公式包一层可拦截的容器。
 *
 * rehype-katex 把 `$$…$$` 渲染成裸 `<span class="katex-display">`(原来的
 * `<pre>` 包装被 splice 掉),react-markdown 的 components 映射只认 tagName、
 * 认不了 class——直接写 `span` 渲染器会命中每个公式内部的几十个嵌套 span 和
 * 所有 hljs span,不可取。本插件排在 rehypeKatex 之后,把每个 katex-display
 * 包进 `<div data-math-block>`;`div` 在 markdown 输出里极少见,MarkdownRenderer
 * 用 div 渲染器按该 marker 挂「复制为图片 / 标注」hover 工具栏(MathBlock)。
 * 行内公式(`.katex` 无 display)不受影响。
 */

import type { Plugin } from 'unified';
import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

function isKatexDisplay(node: Element): boolean {
  if (node.tagName !== 'span') return false;
  const cls = node.properties?.className;
  return Array.isArray(cls) && cls.includes('katex-display');
}

export const rehypeMathBlockMarker: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (index === undefined || parent === undefined) return;
      // 已包装的跳过(理论上单次 pipeline 不会重入,防御性判断)。
      if (parent.type === 'element' && (parent as Element).properties?.dataMathBlock !== undefined) {
        return;
      }
      if (!isKatexDisplay(node)) return;
      const wrapper: Element = {
        type: 'element',
        tagName: 'div',
        properties: { dataMathBlock: '' },
        children: [node],
      };
      parent.children[index] = wrapper;
    });
  };
};
