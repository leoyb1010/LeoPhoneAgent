import { describe, expect, it } from 'vitest';

import {
  MENTION_TOKEN_SPLIT,
  formatMentionRef,
  mentionRefNeedsQuoting,
  parseMentionToken,
} from '@/lib/mentionRefFormat';

/** 模拟 UserMessage.renderContent 的切词：返回每个 mention token 解析出的 ref。 */
function extractMentionRefs(line: string): string[] {
  const refs: string[] = [];
  for (const part of line.split(MENTION_TOKEN_SPLIT)) {
    if (part && part.startsWith('@')) refs.push(parseMentionToken(part).ref);
  }
  return refs;
}

describe('mentionRefFormat', () => {
  it('只在 path 含空白或引号时加引号', () => {
    expect(mentionRefNeedsQuoting('docs/README.md')).toBe(false);
    expect(mentionRefNeedsQuoting('参考-Smack Studio 角色编辑器.md')).toBe(true);
    expect(mentionRefNeedsQuoting('weird"name.md')).toBe(true);

    expect(formatMentionRef('docs/README.md')).toBe('docs/README.md');
    expect(formatMentionRef('参考-Smack Studio 角色编辑器.md')).toBe(
      '"参考-Smack Studio 角色编辑器.md"',
    );
    expect(formatMentionRef('a "b".md')).toBe('"a \\"b\\".md"');
  });

  it('裸形式 path 序列化后能原样切回', () => {
    const ref = 'src/components/Foo.tsx';
    const line = `@${formatMentionRef(ref)} done`;
    expect(line).toBe('@src/components/Foo.tsx done');
    expect(extractMentionRefs(line)).toEqual([ref]);
  });

  it('含空格的中文文件名序列化为引号形式并整体切回（修复截断 bug）', () => {
    const ref = '参考-Smack Studio 角色编辑器.md';
    const line = `看下 @${formatMentionRef(ref)} 这个`;
    expect(line).toBe('看下 @"参考-Smack Studio 角色编辑器.md" 这个');
    // 旧的 @\S+ 会切成 ['参考-Smack']；现在应整体还原。
    expect(extractMentionRefs(line)).toEqual([ref]);
  });

  it('含空格的目录引用尾斜杠纳入引号内', () => {
    const line = `@${formatMentionRef('my docs/')}`;
    expect(line).toBe('@"my docs/"');
    const [ref] = extractMentionRefs(line);
    expect(ref).toBe('my docs/');
    expect(ref.endsWith('/')).toBe(true);
  });

  it('Windows 含空格绝对路径(反斜杠)序列化后反斜杠不被吞、整体切回', () => {
    const ref = 'C:\\Users\\My Documents\\file.md';
    const line = `@${formatMentionRef(ref)}`;
    // 只有 `"` 被转义，反斜杠原样保留
    expect(line).toBe('@"C:\\Users\\My Documents\\file.md"');
    expect(extractMentionRefs(line)).toEqual([ref]);
  });

  it('引号内转义字符能正确反转义', () => {
    const ref = 'a "b".md';
    const line = `@${formatMentionRef(ref)}`;
    expect(line).toBe('@"a \\"b\\".md"');
    expect(extractMentionRefs(line)).toEqual([ref]);
  });

  it('同一行混合引号与裸形式都能切出', () => {
    const line = `@"参考 文档.md" 和 @src/App.tsx`;
    expect(extractMentionRefs(line)).toEqual(['参考 文档.md', 'src/App.tsx']);
  });

  it('email 形态不受影响（@example.com 仍按裸 token 切出，由调用方前缀空白判定）', () => {
    expect(extractMentionRefs('user@example.com')).toEqual(['example.com']);
  });
});
