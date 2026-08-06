import { describe, expect, it } from 'vitest';

import { toAppServerInput } from '../../../../../packages/maker-core/src/agents/codex/index';
import type { UserMessage } from '../../../../../packages/maker-core/src/types/common';

// 注意: toAppServerInput 自 image-resizer 接通后改为 async。image block 的 path
// 会先经 resizer.process() 透明替换 — 但测试里用的虚拟 path (C:\tmp\shot.png) 在
// 磁盘上不存在, fs.stat 失败后 resizer 直接返回原 path, 期望值不变。
describe('Codex app-server input', () => {
  it('formats file attachments with the same files-mentioned preamble shape as Codex Desktop', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Read this file' },
      { type: 'file', path: 'E:\\repo\\README.md', mimeType: 'text/markdown' },
      { type: 'file', path: 'E:\\repo\\notes.md', mimeType: 'text/markdown' },
    ];

    expect(await toAppServerInput(content)).toEqual([
      {
        type: 'text',
        text: [
          '# Files mentioned by the user:',
          '',
          '## README.md: E:\\repo\\README.md',
          '',
          '## notes.md: E:\\repo\\notes.md',
          '',
          '## My request for Codex:',
          'Read this file',
        ].join('\n'),
      },
    ]);
  });

  it('strips file URL prefixes for local images and file references', async () => {
    const content: UserMessage['content'] = [
      { type: 'image', path: 'file://C:\\tmp\\shot.png', mimeType: 'image/png' },
      { type: 'file', path: 'file://C:\\tmp\\notes.txt', mimeType: 'text/plain' },
    ];

    expect(await toAppServerInput(content)).toEqual([
      { type: 'localImage', path: 'C:\\tmp\\shot.png' },
      {
        type: 'text',
        text: ['# Files mentioned by the user:', '', '## notes.txt: C:\\tmp\\notes.txt'].join('\n'),
      },
    ]);
  });

  it('resolves relative mention chips against the working directory', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Read @src/app.ts' },
      { type: 'mention', name: 'app.ts', path: 'src\\app.ts', kind: 'file' },
    ];

    expect(await toAppServerInput(content, 'E:\\repo')).toEqual([
      {
        type: 'text',
        text: [
          '# Files mentioned by the user:',
          '',
          '## app.ts: E:\\repo\\src\\app.ts',
          '',
          '## My request for Codex:',
          'Read @src/app.ts',
        ].join('\n'),
      },
    ]);
  });

  it('preserves app and plugin mentions as structured tool mentions', async () => {
    const content: UserMessage['content'] = [
      { type: 'text', text: 'Use $demo' },
      { type: 'mention', name: 'Demo App', path: 'app://demo-app' },
      { type: 'mention', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ];

    expect(await toAppServerInput(content, 'E:\\repo')).toEqual([
      { type: 'text', text: 'Use $demo' },
      { type: 'mention', name: 'Demo App', path: 'app://demo-app' },
      { type: 'mention', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ]);
  });
});
