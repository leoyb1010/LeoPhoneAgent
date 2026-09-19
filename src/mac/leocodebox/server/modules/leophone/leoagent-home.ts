import os from 'node:os';
import path from 'node:path';

/**
 * LeoAgent 数据根目录(与 leoagent Python 同名同义)。
 *
 * 独立成文件,是为了让 pi-runtime / harness-specs 这类"被 harness-session
 * 依赖"的模块也能引用它,而不绕回 harness-session.service 形成循环 import。
 */
export const LEOAGENT_HOME = (() => {
  const fromEnv = (process.env.LEOAGENT_HOME || '').trim();
  return fromEnv ? fromEnv.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.leoagent');
})();
