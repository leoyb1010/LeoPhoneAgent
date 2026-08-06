/**
 * textLightboxCodeMirrorPreview.test.ts
 * ---------------------------------------------------------------------------
 * TextLightbox 的 text/code 预览必须复用项目已有 CodeMirror 引擎，避免手写
 * 虚拟滚动和异步 DOM 替换造成打开、滚动时的视觉跳变。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'components', 'chat', 'TextLightbox.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('TextLightbox — CodeMirror text/code preview', () => {
  it('uses PlaintextEditor as the read-only preview engine for text and code files', () => {
    expect(source).toMatch(/PlaintextEditor[\s\S]*PlaintextEditorHandle/);
    expect(source).toMatch(/<PlaintextEditor[\s\S]*readOnly[\s\S]*initialValue=\{loadState\.content\}/);
    expect(source).toMatch(/language=\{renderable\.kind === 'code' \? renderable\.lang : undefined\}/);
  });

  it('routes path:line jumps for text/code through CodeMirror instead of manual scrollTop math', () => {
    expect(source).toContain('editorRef.current?.scrollToLine(line)');
    expect(source).not.toContain('computeLineScrollTop(line, lineHeight)');
  });

  it('does not keep the hand-written virtual text renderer or worker highlight path', () => {
    expect(source).not.toContain('buildVirtualTextRows');
    expect(source).not.toContain('getVirtualTextWindow');
    expect(source).not.toContain('virtualHighlightedHtml');
    expect(source).not.toContain('createHighlightWorker');
  });
});
