/**
 * Read 工具的图片自动压缩 hook (PreToolUse).
 *
 * 解决问题:
 *   Claude agent 自己决定调 Read 读本地大图时, 没经过应用入口的"用户附图压缩"路径,
 *   原图字节直接进 vision pipeline, 把上下文 token 撑爆 (同事自动化测试踩到过).
 *
 * 行为:
 *   1. PreToolUse 阶段拿到 Read 的 tool_input.file_path
 *   2. 扩展名命中图片 → 调 ImageResizer.process(原路径)
 *   3. ImageResizer 把原图缩成 vision-friendly 的 WebP 副本, 放在 os.tmpdir() 下
 *   4. 把 tool_input.file_path 改写到副本路径, 通过 hookSpecificOutput.updatedInput
 *      还给 SDK; SDK 用副本路径继续执行 Read, 原图一字节不动
 *
 * 关键保证:
 *   - **永远不动用户原图**: ImageResizer 写到独立缓存目录 (cacheDir, 默认
 *     os.tmpdir()/maker-core-image-resize), 输入路径只读, 没有任何 write/rename
 *     针对原文件的代码路径
 *   - **失败永远降级**: sharp 没装 / 解码失败 / 超时 / 不支持的格式 (多帧 GIF 等)
 *     → ImageResizer 返回原路径, hook 不改写, Claude 仍能读到原图 (只是没缩)
 *   - **小图自动跳过**: ImageResizer 默认 ≤500KB 直接返回原路径, 不浪费 CPU
 *   - **缓存共享**: 复用 maker-core 全局单例, 跟"用户附图"那条路共享 SHA256 缓存
 *     —— 同一张图同一 mtime/size 命中零成本, 跨 session、跨 agent 复用
 *
 * 注意:
 *   - 故意不收 .svg —— SVG 是 XML 文本, Claude Read 当文本读才能完整理解 DOM 结构;
 *     走 sharp 渲染成位图反而丢语义
 *   - 故意不读 magic byte 校验真实类型 —— 这是 host 自家场景, 没人会故意改后缀骗
 *     hook; 每个 Read 多一次 IO 不划算
 *
 * 位置说明: 本文件在 host 层 (apps/desktop/src/main/maker-host/claude-hooks/),
 *           maker-core 不感知具体业务 hook —— 只暴露 AgentDeps.claudeHooks 注入点。
 */

import path from 'node:path';

import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { getDefaultImageResizer, type Logger } from '@cindy/maker-core';

const IMAGE_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.jfif',
  '.gif',
  '.bmp',
  '.webp',
  '.avif',
  '.ico',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
]);

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * 工厂函数: 绑定 logger 后返回标准 HookCallback.
 *
 * 注册示例 (在构造 ClaudeCodeAgent 时一次性创建):
 *   new ClaudeCodeAgent({
 *     ...,
 *     claudeHooks: {
 *       PreToolUse: [
 *         { matcher: 'Read', hooks: [createReadImageHook(logger)] },
 *       ],
 *     },
 *   })
 */
export function createReadImageHook(logger: Logger): HookCallback {
  const log = logger.child('hook/read-image');
  const resizer = getDefaultImageResizer();
  return async (input, toolUseId) => {
    // matcher='Read' 已经在 SDK 层过滤, 这里再做一次防御性判断, 防止
    // 注册侧漏配 matcher 或未来共享到其它 event 类型时误命中
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true };
    }
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== 'Read') {
      return { continue: true };
    }
    const toolInput = pre.tool_input as Record<string, unknown> | null | undefined;
    const rawFilePath = toolInput?.file_path;
    if (typeof rawFilePath !== 'string' || rawFilePath.length === 0) {
      return { continue: true };
    }
    if (!isImagePath(rawFilePath)) {
      return { continue: true };
    }

    // ImageResizer.process 永远 resolve, 不抛错; 返回:
    //   - 副本路径 (新缩 / 缓存命中) → 跟原路径不等, 需要改写
    //   - 原路径   (≤500KB / sharp 没装 / 解码失败 / 超时) → 不改写
    let shrunkPath: string;
    try {
      shrunkPath = await resizer.process(rawFilePath);
    } catch (e) {
      // 理论上 process 不抛 (它内部全 catch 了), 这是兜底防御
      log.warn('image read shrink threw, passthrough', {
        filePath: rawFilePath,
        error: String(e),
      });
      return { continue: true };
    }

    if (shrunkPath === rawFilePath) {
      // 跳过短路 / 缩失败 → 让 SDK 走原路径
      log.debug('image read passthrough', {
        filePath: rawFilePath,
        toolUseId,
      });
      return { continue: true };
    }

    // 改写 file_path → SDK 后续用副本路径执行 Read
    log.debug('image read shrunk', {
      original: rawFilePath,
      shrunkTo: shrunkPath,
      toolUseId,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...toolInput,
          file_path: shrunkPath,
        },
      },
    };
  };
}
