/**
 * Re-export shared BROWSER_PARTITION 给 right-sidebar 子树用。
 *
 * 单一来源在 `apps/desktop/src/shared/webviewPartition.ts`(main / renderer 共用,
 * main 端 hardener 强制覆盖到这个值)。这里 re-export 保持 plan 里"renderer
 * lib/browserPartition" 入口约定,内部消费者(plugin / pool / hook)从这里 import,
 * 同时被 main 端强制对齐,不会出现两份分歧。
 */
// 相对路径 — renderer tsconfig 的 `@/*` alias 只映射 `src/renderer/*`,跨包到
// `src/shared/` 需要走相对。
export { BROWSER_PARTITION } from '../../../../shared/webviewPartition';
