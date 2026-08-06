#!/usr/bin/env node
/**
 * 渲染 trace 组件级归因(配合 render-trace.mjs,dev-only 排查工具)。
 * ---------------------------------------------------------------------------
 * 用法:
 *   node apps/mobile/scripts/render-trace-analyze.mjs <trace.json> [--component HomeSessionRow]
 * 输出:
 *  1. 各组件总渲染耗时 / 次数 top-20(b/e 配对求和,嵌套父含子);
 *  2. 目标组件的 renders/秒时间线(风暴 = 持续高值;健康 = 接近全零);
 *  3. Changed Props 供词 top-10(React DevTools 标注的重渲染原因,
 *     "referentially unequal but deeply equal" = 引用不稳定,优先修)。
 *
 * 判定基准(2026-07-18 风暴修复实测,~2 分钟采样、桌面端流式输出场景):
 *  - 病态:HomeSessionRow 7586 次、SectionList 全列表 37 次 × ~1.4s;
 *  - 修复后:HomeSessionRow ~70 次、壳层 pass 收敛到变化行。
 * 重构后跑同场景对比这两组量级即可判定回归。大 trace 建议
 * node --max-old-space-size=8192 运行。
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法: node render-trace-analyze.mjs <trace.json> [--component HomeSessionRow]');
  process.exit(1);
}
const idx = args.indexOf('--component');
const targetComponent = idx >= 0 && args[idx + 1] ? args[idx + 1] : 'HomeSessionRow';

const { traceEvents } = JSON.parse(readFileSync(file, 'utf8'));
const clean = (name) => name.replace(/​/g, '');

let tMin = Infinity;
let tMax = -Infinity;
for (const ev of traceEvents) {
  if (typeof ev.ts === 'number') {
    tMin = Math.min(tMin, ev.ts);
    tMax = Math.max(tMax, ev.ts);
  }
}
console.log(`窗口时长 ${((tMax - tMin) / 1e6).toFixed(1)}s,事件 ${traceEvents.length} 条`);

// b/e 配对:按 name|id 记 open 时刻,配对求和(React 组件 span 嵌套良好,父含子)
const open = new Map();
const total = new Map();
const count = new Map();
const buckets = new Map();
for (const ev of traceEvents) {
  if (ev.ph !== 'b' && ev.ph !== 'e') continue;
  const name = clean(ev.name);
  const key = `${name}|${ev.id}`;
  if (ev.ph === 'b') {
    open.set(key, ev.ts);
    if (name.includes(targetComponent)) {
      const sec = Math.floor((ev.ts - tMin) / 1e6);
      buckets.set(sec, (buckets.get(sec) ?? 0) + 1);
    }
  } else {
    const t0 = open.get(key);
    if (t0 === undefined) continue;
    open.delete(key);
    total.set(name, (total.get(name) ?? 0) + (ev.ts - t0));
    count.set(name, (count.get(name) ?? 0) + 1);
  }
}

console.log('\n== 组件总渲染耗时 top-20(父含子)==');
[...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([name, dur]) => {
  console.log(`${String((dur / 1000).toFixed(0)).padStart(8)} ms ${String(count.get(name)).padStart(7)}x ${name.slice(0, 56)}`);
});

console.log(`\n== ${targetComponent} renders/秒时间线 ==`);
const maxSec = buckets.size > 0 ? Math.max(...buckets.keys()) : -1;
const line = [];
for (let s = 0; s <= maxSec; s += 1) line.push(buckets.get(s) ?? 0);
console.log(line.length > 0 ? line.join(' ') : '(无渲染记录)');
console.log(`合计 ${[...buckets.values()].reduce((a, b) => a + b, 0)} 次`);

console.log('\n== Changed Props 供词 top-10 ==');
const reasons = new Map();
for (const ev of traceEvents) {
  if (ev.ph !== 'b' || !ev.args?.detail) continue;
  try {
    const props = JSON.parse(ev.args.detail)?.devtools?.properties;
    if (!props) continue;
    const key = `${clean(ev.name)} :: ${JSON.stringify(props).slice(0, 110)}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  } catch {
    // detail 非 JSON 的事件直接跳过
  }
}
[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([key, n]) => {
  console.log(`${String(n).padStart(7)}x ${key.slice(0, 150)}`);
});
