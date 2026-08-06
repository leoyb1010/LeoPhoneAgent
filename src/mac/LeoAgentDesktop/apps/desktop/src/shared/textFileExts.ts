/**
 * textFileExts — 文本/代码/markdown 文件类型白名单。
 *
 * 真源已迁至 @cindy/file-browser-core(P0 抽包):白名单同时驱动 desktop 的
 * 附件分类/预览判断(renderer)、rg 搜索 glob(main),以及远端 file-service
 * daemon 的同一套搜索范围——三个消费点必须共享单一定义,所以定义放在包里,
 * 这里保留 re-export 让 desktop 内既有 import 路径(@/shared/textFileExts、
 * ../shared/textFileExts.js)全部不变。
 *
 * 新增扩展名去 packages/file-browser-core/src/textFileExts.ts 改。
 *
 * ⚠️ 必须走 /textFileExts 子路径导出而不是包根:本文件被 renderer 消费,
 * 包根 barrel 会把 scanner / RipgrepSearcher 等 Node-only 实现(node:events、
 * node:fs)一起拖进浏览器 bundle,Vite externalize 后类定义在运行时直接抛
 * "Class extends value undefined",导致 renderer 白屏。
 */

export {
  SUPPORTED_TEXT_EXTS,
  COMPOUND_EXTS,
  KNOWN_TEXT_FILENAMES,
} from '@cindy/file-browser-core/textFileExts';
