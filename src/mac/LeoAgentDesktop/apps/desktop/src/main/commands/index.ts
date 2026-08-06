/**
 * Desktop commands 模块入口 —— 单例 + bootstrap helper。
 *
 * 用法 (在 bootstrap-electron.ts 里):
 *   import { getDesktopCommandRegistry, registerBuiltinDesktopCommands } from './commands/index.js';
 *   registerBuiltinDesktopCommands(getDesktopCommandRegistry());
 *
 * IPC 暴露见 maker-ipc/desktop-commands.ts (待 Step 5 添加)。
 */

import { DesktopCommandRegistry } from './registry.js';

export { DesktopCommandRegistry } from './registry.js';
export type { DesktopCommandContext, DesktopCommandDefinition } from './registry.js';
export { registerBuiltinDesktopCommands } from './builtins.js';
export type { DesktopCommandTriggeredPayload } from './builtins.js';

let singleton: DesktopCommandRegistry | undefined;

/**
 * 获取进程内单例 registry。第一次访问时构造, 之后复用。
 * builtins 由调用方显式注册 —— 单例本身不自动注册任何命令, 让构造副作用最小化,
 * 测试也好控制。
 */
export function getDesktopCommandRegistry(): DesktopCommandRegistry {
  if (!singleton) singleton = new DesktopCommandRegistry();
  return singleton;
}
