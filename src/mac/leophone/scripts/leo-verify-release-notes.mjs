// [leo][T-release-notes] 发版闸门。
//
// 根 package.json 的 version 必须是 leoReleaseNotes.ts 里最前面那条,且条目非空。
// 挂在 leo:bundle:mac 链首:漏写更新说明就打不出包。
// 闸门是拿来挡自己的 —— 挂了就去补条目,不要删测试、不要绕过链路。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const version = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", root)), "utf8"),
).version;
const source = readFileSync(
  fileURLToPath(new URL("packages/ui/src/leo/leoReleaseNotes.ts", root)),
  "utf8",
);

const declared = [...source.matchAll(/version:\s*"([^"]+)"/g)].map((m) => m[1]);
if (declared[0] !== version) {
  console.error(
    `leo-verify-release-notes: package.json 是 ${version},但 leoReleaseNotes.ts 最前一条是 ${declared[0] ?? "(空)"} —— 先补「本次更新」再打包。`,
  );
  process.exit(1);
}

const entry = source.slice(source.indexOf(`version: "${version}"`));
const items = /items:\s*\[([\s\S]*?)\n\s*\]/.exec(entry)?.[1] ?? "";
if (!items.includes('"')) {
  console.error(`leo-verify-release-notes: ${version} 的 items 是空的。`);
  process.exit(1);
}

console.log(`leo-verify-release-notes: ${version} 有更新说明(${(items.match(/",\n/g) ?? []).length + 1} 条),放行。`);
