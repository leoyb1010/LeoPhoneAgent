// [leo] 发布前把产物整理成两份更新清单:
//   1. leophone-manifest-darwin-arm64.json —— 3.x 自己的 manifest(ManifestUpdateProvider 读它)
//   2. latest-mac.yml —— 给还在 2.2.x 的老客户端(electron-updater generic 源)跳过来用
// 两份都指向同一个 zip,sha512 现算,不手抄。
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const version = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")).version;
const distDir = fileURLToPath(new URL("packages/desktop/dist/", root));
const RELEASE_BASE = `https://github.com/leoyb1010/leocodebox-updates/releases/download/v${version}`;

const files = readdirSync(distDir);
const zipName = files.find((name) => name.endsWith(".zip") && name.includes(version));
const dmgName = files.find((name) => name.endsWith(".dmg") && name.includes(version));
if (!zipName) {
  console.error(`leo-finalize: ${distDir} 里没有 ${version} 的 zip —— 先跑 leo:bundle:mac。`);
  process.exit(1);
}

const sha512 = await new Promise((resolve, reject) => {
  const hash = createHash("sha512");
  createReadStream(join(distDir, zipName))
    .on("data", (chunk) => hash.update(chunk))
    .on("end", () => resolve(hash.digest("base64")))
    .on("error", reject);
});
const size = statSync(join(distDir, zipName)).size;
const releaseDate = new Date().toISOString();

writeFileSync(
  join(distDir, "leophone-manifest-darwin-arm64.json"),
  `${JSON.stringify({ version, releaseDate, files: [{ url: `${RELEASE_BASE}/${encodeURIComponent(zipName)}`, sha512, size }] }, null, 2)}\n`,
);
writeFileSync(
  join(distDir, "latest-mac.yml"),
  [
    `version: ${version}`,
    "files:",
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n"),
);
console.log(`leo-finalize: ${version}\n  zip ${zipName}\n  dmg ${dmgName ?? "(无)"}\n  manifest + latest-mac.yml 已生成于 ${distDir}`);
