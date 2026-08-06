import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'ModelLightbox.tsx'),
  'utf8',
);

describe('ModelLightbox', () => {
  it('keeps close callback stable so model ensure does not restart on parent rerender', () => {
    expect(source).toContain('const onCloseRef = useRef(onClose)');
    const handleCloseMatch = source.match(/const handleClose = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[(.*?)\]\);/);
    expect(handleCloseMatch).not.toBeNull();
    if (!handleCloseMatch) throw new Error('handleClose useCallback block not found');
    expect(handleCloseMatch[1]).toContain('onCloseRef.current()');
    expect(handleCloseMatch[1]).not.toContain('onClose(');
    // Esc 关闭前必须先 blur 掉焦点 —— 否则 model-viewer shadow DOM 的
    // .userInput 会在淡出期间闪出键盘焦点框(全局 outline:none 穿不进 shadow)。
    expect(handleCloseMatch[1]).toContain('.blur?.()');
    expect(handleCloseMatch[2].trim()).toBe('');
    // mivo 懒下载来源已随老 MCP 摘壳退役,模型 ensure 效果的依赖只剩稳定的
    // handleClose——断言跟着源码走,守的仍是"父级重渲不重启加载"这条约。
    expect(source).toContain('}, [handleClose]);');
  });

  it('surfaces model load failure instead of silently staying on the poster', () => {
    // <model-viewer> only dispatches an 'error' event on load/parse failure
    // and keeps showing the poster — without this listener the lightbox looks
    // like a frozen 2D image (the exact symptom of the 2026-06 scheme
    // privilege regression). Contract: listener registered + user-visible
    // toast with the modelLoadFailed copy.
    expect(source).toContain("addEventListener('error'");
    expect(source).toContain('chat.media.modelLoadFailed');
  });

  it('has no in-app FBX rendering path', () => {
    // FBX 预览已被有意移除(model-viewer 只认 glTF;three.js 自渲 Phong 观感
    // 与 GLB 差异大反而误导),.fbx chip 走 Finder 定位。契约:不许再把
    // three / FbxModelViewer 引回本组件(那是第二份 three 实例)。
    expect(source).not.toContain('FbxModelViewer');
    expect(source).not.toMatch(/from 'three/);
  });
});
