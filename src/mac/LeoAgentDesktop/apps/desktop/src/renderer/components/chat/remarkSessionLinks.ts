/**
 * remarkSessionLinks — 把正文纯文本里裸写的 Cindy 深链切成 mdast `link`
 * 节点(cindy:// 主 scheme + 历史 xdt-maker:// 都认),让它进入 `a` 渲染器
 * 的对应分支:
 *   - `<scheme>://session/<id>[?message=<clientId>]` → SessionLinkChip
 *   - `<scheme>://project/<urlencoded-workingDir>`   → ProjectLinkChip
 *
 * 背景:remark-gfm 的 autolink 只识别 http(s) / www / mailto,自定义 scheme
 * 的裸 URL(用户 / agent 直接把复制来的深链粘进正文)会被当普通文字渲染,
 * 点不动。显式 `[label](<scheme>://session/...)` 语法不受影响、本插件也不碰
 * (跳过 link 内 text,避免嵌套)。
 *
 * 匹配策略:ASCII 白名单正则(id 段 + 可选 query 段),CJK / 空白 / 中文标点
 * 处天然收尾;匹配后剥尾部粘连的英文句读(`.` `,` 等),再用
 * parseSessionDeepLinkHref 复核形状——解析不出 sessionId 的残缺串不切,
 * 维持纯文本。纯 AST 变换,无 IO、无副作用。
 *
 * 注意:本插件只应注册在受信任内容的插件链上(allowPrivilegedLinks),
 * Market 等外部内容不启用——与 trustedUrlTransform 的门控口径一致。
 */

import type { Plugin } from 'unified';
import type { Root, Text, Link, PhrasingContent } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';

import {
  parseSessionDeepLinkHref,
  parseProjectDeepLinkHref,
  SESSION_DEEP_LINK_RE_SOURCE,
  PROJECT_DEEP_LINK_RE_SOURCE,
} from '@/lib/deepLink';
import { textContainsDeepLink } from '../../../shared/deepLinkSchemes';

interface SessionLinkMatch {
  start: number;
  end: number; // 不含
  value: string;
}

/** 在一段纯文本里定位所有可解析的深链(session / project)token。 */
function findSessionLinkMatches(text: string): SessionLinkMatch[] {
  const matches: SessionLinkMatch[] = [];
  // 正则源与 lib/deepLink.ts 单点共享(userMessageLinkify / pastePipeline 同源)。
  const combined = new RegExp(
    `(${SESSION_DEEP_LINK_RE_SOURCE})|(${PROJECT_DEEP_LINK_RE_SOURCE})`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = combined.exec(text)) !== null) {
    // 剥尾部粘连的英文句读:"…session/xxx?message=yyy." 的句号不属于链接。
    const value = m[0].replace(/[.,;:!?]+$/, '');
    const valid = m[1] !== undefined
      ? parseSessionDeepLinkHref(value)
      : parseProjectDeepLinkHref(value);
    if (!valid) continue;
    matches.push({ start: m.index, end: m.index + value.length, value });
  }
  return matches;
}

/** 把一个 text 节点按命中区间拆成 [text, link, text, ...]。 */
function splitTextNode(node: Text, matches: SessionLinkMatch[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  const value = node.value;
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, match.start) });
    }
    const link: Link = {
      type: 'link',
      url: match.value,
      children: [{ type: 'text', value: match.value }],
    };
    out.push(link);
    cursor = match.end;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

const remarkSessionLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null) return;
      // 已在链接里的 text 不动:避免把链接 label 再切成嵌套链接。
      if (parent.type === 'link') return;
      // 快速预筛:双 scheme(cindy:// / xdt-maker://)任一出现才进正则。
      if (!node.value || !textContainsDeepLink(node.value)) return;

      const matches = findSessionLinkMatches(node.value);
      if (matches.length === 0) return;

      const replacement = splitTextNode(node, matches);
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
};

export default remarkSessionLinks;
