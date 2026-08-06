/**
 * cronToHuman — 透传 Phase 1 引擎的英文输出
 * ---------------------------------------------------------------------------
 * Phase 1 `@cindy/maker-scheduler/engine/cron.ts:cronToHuman` 已是英文 + 纯函数。
 * Scheduler UI 已统一英文（Phase 8），这里直接透传，不再做 zh i18n 包装。
 *
 * 仍保留这个 wrapper 文件而不是直接 import 引擎是为了：
 * (a) 限定从 ./cron 子路径 import — 顶层 `@cindy/maker-scheduler` re-export 的
 *     `./engine/scheduler.js` 用 EventEmitter，浏览器加载即崩。
 * (b) 给将来再做 i18n 留单一改点。
 */

import { cronToHuman as cronToHumanEN } from '@cindy/maker-scheduler/cron';

export function cronToHuman(expr: string): string {
  return cronToHumanEN(expr);
}
