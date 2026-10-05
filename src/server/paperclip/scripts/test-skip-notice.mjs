// 1.1.6：node --test 自定义 reporter，只在结束时输出一行跳过提示，避免 `npm test` 静默跳过上游回归。
// 大多数回归需要 PAPERCLIP_SOURCE（固定上游源码目录）；生成产物比对还需要 PAPERCLIP_CANDIDATE。
export default async function* skipNotice(source) {
  let skipped = 0;
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data?.skip !== undefined && event.data.skip !== false && event.data.details?.type !== 'suite') skipped += 1;
  }
  if (!skipped) return;
  if (!process.env.PAPERCLIP_SOURCE) yield `\n注意：${skipped} 项因缺少 PAPERCLIP_SOURCE 被跳过。完整验证请运行 npm run test:full（默认使用 .upstream）。\n`;
  else if (!process.env.PAPERCLIP_CANDIDATE) yield `\n注意：${skipped} 项因缺少 PAPERCLIP_CANDIDATE 被跳过（生成产物比对）。完整验证请同时设置 PAPERCLIP_CANDIDATE。\n`;
  else yield `\n注意：${skipped} 项被跳过。\n`;
}
