#!/usr/bin/env node
/**
 * [leo] 独立性红线闸门：源码与构建产物里不允许出现官方服务地址。
 *
 * 命中即非零退出。挂在 `leo:bundle:mac` 链首（与 leo-verify-release-notes 并列），
 * 漏改的上游新增联网点、被 vite / tsup 编进产物的官方地址都在出包前拦下。
 *
 * 匹配的是「域名形态」：z.ai / bigmodel.cn / zhipuai.cn / zhipu.ai / chatglm.cn / codegeex.cn /
 * zcode.ai（含任意子域，如 cdn-zcode.z.ai、open.bigmodel.cn）以及官方 OAuth client id 前缀 client_P8X5。
 * 不匹配 `bigmodel` / `zhipu` 这类标识符：它们是 CLI 协议与旧配置读取共用的 provider id
 * （BUILTIN_MODEL_PROVIDER_IDS、zhipu-account 等），按 docs/mac-3.0 的约定「文件随包、行为切断」保留。
 *
 * 另查源码里指向官方客户端数据目录的路径（`~/.zcode`、`join(homedir(), ".zcode")` 一类）：LeoBot 的数据根是
 * ~/.leophoneagent，读官方目录会让两边设置互相串（曾经硬件加速开关就读的 ~/.zcode）。项目级 `<workspace>/.zcode`
 * 是上游的项目配置目录，不算。注释不查；迁移旧数据这类确需写出的地方进 ZCODE_PATH_ALLOWLIST。
 *
 * 用法（在 src/mac/leophone 下）：
 *   node scripts/leo-redline-check.mjs                 # 源码 + 已存在的构建产物
 *   node scripts/leo-redline-check.mjs --source-only
 *   node scripts/leo-redline-check.mjs --artifacts-only [--require-artifacts]
 *   node scripts/leo-redline-check.mjs --path <file或目录> ...   # 只查指定路径（反向验证用）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REDLINE_PATTERN =
  /(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)*(?:z\.ai|bigmodel\.cn|zhipuai\.cn|zhipu\.ai|chatglm\.cn|codegeex\.cn|zcode\.ai)(?![A-Za-z0-9-])|client_P8X5/g;

/**
 * 白名单：只放拦截规则本身这类「必须写出域名」的位置。新增条目要写清理由。
 */
const ALLOWLIST = new Map([
  // 闸门自身：注释与正则里写着要拦的域名。
  ["scripts/leo-redline-check.mjs", "红线闸门自身"],
]);

/** 不随产品发出去的路径：测试、文档、上游内部工具、未随包的插件。 */
const EXCLUDED_PATH_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)(test|tests|__tests__|e2e|test-fixtures|fixtures)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^docs\//,
  /^apps\/zcode-cli\/docs\//,
  /^packages\/[^/]+\/docs\//,
  /^apps\/zcode-cli\/packages\/(?!.*-plugin\/)[^/]+\/docs\//,
  /^[^/]+\.md$/, // 根目录 README / CHANGELOG / NOTICE / THIRD-PARTY-NOTICES 等
  /(^|\/)(CHANGELOG|README|README\.en|NOTICE|LICENSE|LICENSE\.txt|THIRD-PARTY-NOTICES)(\.md)?$/i,
  /^third-party\//,
  /^\.agents\//,
  /^\.claude\//,
  /^pnpm-lock\.yaml$/,
  // 上游内部开发工具，不进安装包。
  /^apps\/dev-docs\//,
  /^packages\/e2e-report\//,
  /^apps\/zcode-cli\/tools\//,
  /^packages\/desktop\/wdio\.conf\.ts$/,
  // 不随包的官方插件（prepare-agent-node-bundle.mjs 不 stage 它们）。
  /^apps\/zcode-cli\/packages\/(documents|pdf|presentations|spreadsheets|image-search|android-emulator|restore-legacy-sessions|zcode-cua)-plugin\//,
  // 构建与本地运行产物由 --artifacts 段单独扫描。
  /(^|\/)(dist|out|build|bundled-agents|\.turbo|coverage)\//,
];

/** 家目录下的官方数据根：`~/.zcode`、`~/.zcode-beta`，或 `join(homedir() / home… / HOME, ".zcode"…)`。 */
export const ZCODE_HOME_PATH_PATTERN =
  /~\/\.zcode(?:-beta)?(?![\w-])|(?:homedir\(\)|\b\w*[hH]ome\w*|\bHOME\b)\s*,\s*["'`]\.zcode(?:-beta)?(?:["'`]|\/)/;

/** 允许出现官方数据根路径的文件（迁移旧数据、给用户看的说明）。新增条目要写清理由。 */
const ZCODE_PATH_ALLOWLIST = new Map([
  ["scripts/leo-redline-check.mjs", "红线闸门自身"],
  ["packages/ui/src/leo/leoReleaseNotes.ts", "更新说明里向用户解释「不再读取 ~/.zcode」"],
  ["packages/ui/src/leo/leoReleaseNotesArchive.ts", "1.9.0 及更早的更新说明(从 leoReleaseNotes.ts 挪出)里向用户解释「不再读取 ~/.zcode」"],
]);

/** 只在开发机上跑、不进安装包的脚本与上游调试工具。 */
const ZCODE_PATH_EXCLUDED = [/(^|\/)scripts\//, /^apps\/zcode-cli\/packages\/debug\//];
/** 只查代码；Markdown / 技能说明里的路径是文字，另行人工处理。 */
const ZCODE_PATH_CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|swift|sh|py)$/i;

/** 去掉整行注释、行尾 `// …` 与 `/* …` 注释后再匹配：注释里写「不读 ~/.zcode」是在说明，不是在读。 */
function stripComment(line) {
  return line.replace(/^\s*(?:\/\/|\*|#).*$/, "").replace(/\/\*.*$/, "").replace(/(^|\s)\/\/\s.*$/, "");
}

function scanZcodePaths(relPath, text, hits) {
  if (!ZCODE_PATH_CODE_EXTENSIONS.test(relPath) || ZCODE_PATH_ALLOWLIST.has(relPath)) return;
  if (ZCODE_PATH_EXCLUDED.some((pattern) => pattern.test(relPath))) return;
  if (!text.includes(".zcode")) return;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = ZCODE_HOME_PATH_PATTERN.exec(stripComment(lines[index]));
    if (match) hits.push({ file: relPath, line: index + 1, match: match[0], context: lines[index].trim().slice(0, 200) });
  }
}

const TEXT_EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|json|jsonc|html|css|scss|md|mdx|ya?ml|toml|env|sh|ps1|py|txt|plist|xml|svg)$|(^|\/)\.env[^/]*$/i;

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function toPosix(path) {
  return path.split(sep).join("/");
}

function isExcluded(relPath) {
  return EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

function listSourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map(toPosix)
    .filter((relPath) => TEXT_EXTENSIONS.test(relPath) && !isExcluded(relPath))
    .filter((relPath) => existsSync(join(rootDir, relPath)));
}

function scanText(relPath, text, hits, { lineNumbers = true } = {}) {
  if (ALLOWLIST.has(relPath)) return;
  REDLINE_PATTERN.lastIndex = 0;
  if (!REDLINE_PATTERN.test(text)) return;
  if (!lineNumbers) {
    REDLINE_PATTERN.lastIndex = 0;
    const seen = new Set();
    for (const match of text.matchAll(REDLINE_PATTERN)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      const start = Math.max(0, match.index - 40);
      const context = text.slice(start, match.index + match[0].length + 40).replace(/\s+/g, " ");
      hits.push({ file: relPath, line: 0, match: match[0], context });
      if (seen.size >= 20) break;
    }
    return;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    REDLINE_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(REDLINE_PATTERN)) {
      hits.push({ file: relPath, line: index + 1, match: match[0], context: line.trim().slice(0, 200) });
    }
  }
}

function scanSource(hits) {
  const files = listSourceFiles();
  for (const relPath of files) {
    const absolute = join(rootDir, relPath);
    const stats = statSync(absolute);
    if (stats.size > MAX_TEXT_BYTES) continue;
    const text = readFileSync(absolute, "utf8");
    scanText(relPath, text, hits);
    scanZcodePaths(relPath, text, hits);
  }
  return files.length;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* walk(absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

/** 构建产物：tsup / vite 输出、agent bundle 与随包插件、打出来的 .app（app.asar 按字节扫）。 */
function artifactRoots() {
  const roots = [
    "packages/desktop/out",
    "packages/desktop/bundled-agents",
    "packages/ui/dist",
    "packages/shared/dist",
    "packages/services/dist",
    "apps/zcode-cli/packages/cli/dist",
  ];
  const distDir = join(rootDir, "packages/desktop/dist");
  if (existsSync(distDir)) {
    for (const entry of readdirSync(distDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^mac/.test(entry.name)) roots.push(`packages/desktop/dist/${entry.name}`);
    }
  }
  return roots.filter((relPath) => existsSync(join(rootDir, relPath)));
}

const ARTIFACT_EXCLUDED = [
  // electron / chromium 自带资源与第三方原生模块不是我们的代码。
  /\/Frameworks\//,
  /\/node_modules\/(?!@zcode\/)/,
  /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|mp4|wasm|node|dylib|so|dll|exe|pak|dat|bin)$/i,
  /\.map$/,
  /\/LICENSE[^/]*$/i,
  /\/THIRD-PARTY-NOTICES[^/]*$/i,
];

function scanArtifacts(hits) {
  let scanned = 0;
  for (const root of artifactRoots()) {
    for (const absolute of walk(join(rootDir, root))) {
      const relPath = toPosix(relative(rootDir, absolute));
      if (ARTIFACT_EXCLUDED.some((pattern) => pattern.test(relPath))) continue;
      const stats = statSync(absolute);
      if (stats.size === 0) continue;
      if (relPath.endsWith(".asar")) {
        scanned += scanAsar(relPath, readFileSync(absolute), hits);
        continue;
      }
      if (stats.size > 64 * 1024 * 1024) continue;
      const text = readFileSync(absolute).toString("latin1");
      scanText(relPath, text, hits, { lineNumbers: stats.size < MAX_TEXT_BYTES });
      scanned += 1;
    }
  }
  return scanned;
}

/**
 * asar = 4 字节 pickle 头 + JSON 文件索引 + 原样拼接的文件体。逐个条目扫描，
 * 让包内路径（如 node_modules/第三方包）与磁盘产物走同一套 ARTIFACT_EXCLUDED 规则。
 */
function scanAsar(relPath, buffer, hits) {
  const headerPickleSize = buffer.readUInt32LE(4);
  const headerJsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.toString("utf8", 16, 16 + headerJsonSize));
  const dataStart = 8 + headerPickleSize;
  let scanned = 0;
  const visit = (node, innerPath) => {
    if (node.files) {
      for (const [name, child] of Object.entries(node.files)) visit(child, `${innerPath}/${name}`);
      return;
    }
    if (node.unpacked || node.link || typeof node.size !== "number" || node.size === 0) return;
    const entryPath = `${relPath}${innerPath}`;
    if (ARTIFACT_EXCLUDED.some((pattern) => pattern.test(entryPath))) return;
    const start = dataStart + Number(node.offset);
    const text = buffer.toString("latin1", start, start + node.size);
    scanText(entryPath, text, hits, { lineNumbers: node.size < MAX_TEXT_BYTES });
    scanned += 1;
  };
  visit(header, "");
  return scanned;
}

function scanPaths(paths, hits) {
  let scanned = 0;
  for (const input of paths) {
    const absolute = resolve(process.cwd(), input);
    const files = statSync(absolute).isDirectory() ? [...walk(absolute)] : [absolute];
    for (const file of files) {
      const relPath = toPosix(relative(rootDir, file));
      const text = readFileSync(file).toString("latin1");
      scanText(relPath, text, hits);
      scanZcodePaths(relPath, text, hits);
      scanned += 1;
    }
  }
  return scanned;
}

function main(argv) {
  const sourceOnly = argv.includes("--source-only");
  const artifactsOnly = argv.includes("--artifacts-only");
  const requireArtifacts = argv.includes("--require-artifacts");
  const pathIndex = argv.indexOf("--path");
  const hits = [];
  const summary = [];

  if (pathIndex !== -1) {
    const paths = argv.slice(pathIndex + 1).filter((arg) => !arg.startsWith("--"));
    summary.push(`paths: ${scanPaths(paths, hits)} files`);
  } else {
    if (!artifactsOnly) summary.push(`source: ${scanSource(hits)} files`);
    if (!sourceOnly) {
      const scanned = scanArtifacts(hits);
      if (requireArtifacts && scanned === 0) {
        console.error("[leo-redline] 没有找到构建产物（--require-artifacts）");
        return 2;
      }
      summary.push(`artifacts: ${scanned} files`);
    }
  }

  if (hits.length > 0) {
    console.error(`[leo-redline] ✗ 发现 ${hits.length} 处官方服务地址 / 官方数据目录（${summary.join(", ")}）：`);
    for (const hit of hits.slice(0, 200)) {
      const where = hit.line ? `${hit.file}:${hit.line}` : hit.file;
      console.error(`  ${where}  [${hit.match}]  ${hit.context}`);
    }
    if (hits.length > 200) console.error(`  …… 另有 ${hits.length - 200} 处`);
    console.error(
      "[leo-redline] LeoBot 不连接官方服务：把地址改成本机死端口 http://127.0.0.1:9 或删除；" +
        "确属拦截规则本身才进 scripts/leo-redline-check.mjs 的 ALLOWLIST。" +
        "官方数据目录 ~/.zcode 改用 ~/.leophoneagent；迁移旧数据才进 ZCODE_PATH_ALLOWLIST。",
    );
    return 1;
  }
  console.log(`[leo-redline] ✓ 0 命中（${summary.join(", ")}）`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
