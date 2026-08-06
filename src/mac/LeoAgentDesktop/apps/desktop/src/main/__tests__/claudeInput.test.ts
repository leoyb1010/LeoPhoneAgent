import { describe, expect, it } from 'vitest';

import { toClaudeSdkContent } from '../../../../../packages/maker-core/src/agents/claude-code/index';
import type { UserMessage } from '../../../../../packages/maker-core/src/types/common';

// 注意: toClaudeSdkContent 自 image-resizer 接通后改为 async。image block 的 path
// 会先经 resizer.process() 透明替换 — 但测试里用的虚拟 path (C:\tmp\shot.png) 在
// 磁盘上不存在, fs.stat 失败后 resizer 直接返回原 path, 期望值不变。
describe('Claude Code SDK input', () => {
  it('keeps file and image attachments as @path refs instead of inline blocks', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Inspect these' },
      { type: 'file', path: 'E:\\repo\\large.txt', mimeType: 'text/plain' },
      { type: 'image', path: 'C:\\tmp\\shot.png', mimeType: 'image/png' },
    ];

    expect(await toClaudeSdkContent(content)).toBe(
      '@"E:\\repo\\large.txt" @"C:\\tmp\\shot.png" Inspect these',
    );
  });

  it('does not duplicate mention chips already serialized in text', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Read @src/app.ts' },
      { type: 'mention', name: 'app.ts', path: 'src/app.ts', kind: 'file' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('Read @src/app.ts');
  });

  it('quotes generated directory refs and preserves the trailing slash', async () => {
    const content: UserMessage['content'] = [
      { type: 'mention', name: 'My Dir', path: 'C:\\My Dir', kind: 'dir' },
    ];

    expect(await toClaudeSdkContent(content)).toBe('@"C:\\My Dir/"');
  });
});
