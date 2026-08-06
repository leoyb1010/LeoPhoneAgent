// 清 Metro / Babel bundler 缓存。
//
// 为什么需要:EXPO_PUBLIC_* 由 babel-preset-expo 在打包时内联成字符串字面量;Metro/Babel 会缓存
// 转换结果,而**只改环境变量、不改源码时缓存 key 不变 → 缓存不失效**,会把旧值(如 placeholder)
// 继续烤进 bundle(尤其持久 CI runner 跨 pipeline 复用 $TMPDIR 缓存)。发布前清一次,确保
// EXPO_PUBLIC_(TAPTAP / OTA_URL / API 等)变更被重新内联。
//
// 说明:OTA 脚本用 `expo export --clear` 即可清;本函数供 local 脚本(gradle / xcodebuild 内部
// 触发 expo export:embed、无法直接透传 --clear)在原生构建前调用。tmp/mobileDir 可注入便于单测。

import { rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 删除 Metro/Babel/Expo 缓存目录(幂等、best-effort,删不掉不抛错)。
 * @param {{ mobileDir: string, tmp?: string, log?: (m: string) => void }} opts
 * @returns {string[]} 实际删除的路径
 */
export function clearBundlerCache({ mobileDir, tmp = tmpdir(), log = () => {} }) {
  if (!mobileDir) throw new Error('clearBundlerCache requires mobileDir');
  const targets = [];
  // 1) $TMPDIR 下的 metro / haste 缓存。只匹配 Metro 自身缓存目录的已知命名
  //    (metro-cache / metro-cache-* / metro-bundler-* / (metro-)haste-map-*),
  //    不用宽泛的 metro-* 前缀——否则会误删 $TMPDIR 下其它以 metro- 开头的无关目录。
  const isMetroCacheDir = (name) =>
    name === 'metro-cache' ||
    name.startsWith('metro-cache-') ||
    name.startsWith('metro-bundler-') ||
    name.startsWith('metro-haste-map-') ||
    name.startsWith('haste-map-');
  try {
    for (const name of readdirSync(tmp)) {
      if (isMetroCacheDir(name)) targets.push(join(tmp, name));
    }
  } catch { /* tmp 不可读则跳过 */ }
  // 2) 项目内 babel-loader / expo 缓存。
  targets.push(join(mobileDir, 'node_modules', '.cache'));
  targets.push(join(mobileDir, '.expo'));

  const removed = [];
  for (const t of targets) {
    try {
      if (existsSync(t)) { rmSync(t, { recursive: true, force: true }); removed.push(t); }
    } catch { /* best-effort,删不掉不阻断构建 */ }
  }
  log(`  ✓ 已清 bundler 缓存(${removed.length} 处),确保 EXPO_PUBLIC_ 变更被重新内联`);
  return removed;
}
