// LeoPhoneAgent 编码能力 eval：8 个自包含任务。
// 每个任务：初始文件（写进临时 git 仓库）、给 agent 的指令、隐藏的检查脚本（在仓库外，cwd=仓库执行，
// 退出码 0 = 通过），以及 dry-run 用的 mock 解题脚本（mock-model-server.mjs 按步回放）。
// 任务只依赖 Node 自带能力（node:test、fs），不装依赖、不联网。

const STATS_JS = `export function sumAll(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function average(values) {
  if (values.length === 0) return 0;
  return sumAll(values) / values.length;
}

export function weightedAverage(values, weights) {
  const weightTotal = sumAll(weights);
  if (weightTotal === 0) return 0;
  return sumAll(values.map((value, index) => value * weights[index])) / weightTotal;
}
`;

const RANGE_JS = `/** Returns the integers from start to end, inclusive. */
export function inclusiveRange(start, end) {
  const result = [];
  for (let value = start; value < end; value += 1) result.push(value);
  return result;
}
`;

const RANGE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { inclusiveRange } from "../src/range.js";

test("inclusive range", () => {
  assert.deepEqual(inclusiveRange(1, 3), [1, 2, 3]);
  assert.deepEqual(inclusiveRange(5, 5), [5]);
});
`;

const STRINGS_JS = `export function capitalize(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
`;

const STRINGS_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { capitalize, slugify } from "../src/strings.js";

test("capitalize", () => {
  assert.equal(capitalize("leo"), "Leo");
});

test("slugify", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Trim me  "), "trim-me");
});
`;

function tableJs() {
  const lines = [];
  for (let index = 1; index <= 3000; index += 1) {
    const id = String(index).padStart(4, "0");
    lines.push(`export const ROW_${id} = { id: ${index}, label: "row ${index}", weight: ${index % 7} };`);
    if (index === 2600) lines.push("export const MAX_RETRIES = 3;");
  }
  return `${lines.join("\n")}\n`;
}

const PACKAGE_JSON = `${JSON.stringify(
  { name: "demo", version: "1.4.2", private: true, scripts: { test: "node --test" } },
  null,
  2,
)}\n`;

/** 检查脚本里的公共片段：读文件、断言、跑 node --test。 */
const CHECK_PRELUDE = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const read = (path) => readFileSync(path, "utf8");
const load = (path) => import(pathToFileURL(resolve(path)).href + "?t=" + Date.now());
const nodeTest = () => {
  const run = spawnSync(process.execPath, ["--test"], { encoding: "utf8" });
  assert.equal(run.status, 0, "node --test failed:\\n" + run.stdout + run.stderr);
};
`;

export const TASKS = [
  {
    id: "rename-function",
    title: "Rename a function used in several places of one file",
    files: { "src/stats.js": STATS_JS },
    prompt:
      "In src/stats.js rename the function `sumAll` to `sumValues` - the definition and every call site in that file. Behavior must stay identical.",
    check: `${CHECK_PRELUDE}
const text = read("src/stats.js");
assert.ok(!text.includes("sumAll"), "sumAll still present");
const mod = await load("src/stats.js");
assert.equal(mod.sumValues([1, 2, 3]), 6);
assert.equal(mod.average([1, 2, 3]), 2);
assert.equal(mod.weightedAverage([1, 3], [1, 1]), 2);
`,
    mock: [
      { tool: "Read", input: { file_path: "src/stats.js" } },
      {
        tool: "Edit",
        input: {
          file_path: "src/stats.js",
          edits: [
            { old_string: "export function sumAll(values) {", new_string: "export function sumValues(values) {" },
            { old_string: "  return sumAll(values) / values.length;", new_string: "  return sumValues(values) / values.length;" },
            { old_string: "  const weightTotal = sumAll(weights);", new_string: "  const weightTotal = sumValues(weights);" },
            {
              old_string: "  return sumAll(values.map((value, index) => value * weights[index])) / weightTotal;",
              new_string: "  return sumValues(values.map((value, index) => value * weights[index])) / weightTotal;",
            },
          ],
        },
      },
    ],
  },
  {
    id: "fix-off-by-one",
    title: "Fix an off-by-one bug so the existing test passes",
    files: { "src/range.js": RANGE_JS, "test/range.test.js": RANGE_TEST },
    prompt: "The test in test/range.test.js fails. Fix the bug in src/range.js so that `node --test` passes. Do not change the test.",
    check: `${CHECK_PRELUDE}
nodeTest();
assert.ok(read("test/range.test.js").includes("inclusiveRange(5, 5)"), "test was modified");
`,
    mock: [
      { tool: "Read", input: { file_path: "src/range.js" } },
      // 故意先错一次（空白不同），验证 editFailures 统计
      { tool: "Edit", input: { file_path: "src/range.js", old_string: "value<end", new_string: "value<=end" } },
      { tool: "Edit", input: { file_path: "src/range.js", old_string: "value < end;", new_string: "value <= end;" } },
      { tool: "Bash", input: { command: "node --test", description: "Run the tests" } },
    ],
  },
  {
    id: "crlf-config",
    title: "Change two values in a CRLF file without converting line endings",
    files: {
      "config/app.ini": "[server]\r\nport = 8080\r\nhost = localhost\r\n\r\n[cache]\r\nenabled = false\r\nttl = 60\r\n",
    },
    prompt: "In config/app.ini set the server port to 9090 and enable the cache (enabled = true). Keep everything else unchanged.",
    check: `${CHECK_PRELUDE}
const raw = read("config/app.ini");
assert.ok(!/[^\\r]\\n/.test(raw), "line endings are no longer CRLF");
assert.ok(raw.includes("port = 9090\\r\\n"));
assert.ok(raw.includes("enabled = true\\r\\n"));
assert.ok(raw.includes("host = localhost\\r\\n") && raw.includes("ttl = 60\\r\\n"));
`,
    mock: [
      { tool: "Read", input: { file_path: "config/app.ini" } },
      {
        tool: "Edit",
        input: {
          file_path: "config/app.ini",
          edits: [
            { old_string: "port = 8080", new_string: "port = 9090" },
            { old_string: "enabled = false", new_string: "enabled = true" },
          ],
        },
      },
    ],
  },
  {
    id: "smart-quotes-doc",
    title: "Edit prose that uses curly quotes and an em dash",
    files: {
      "docs/guide.md":
        "# Guide\n\nThe CLI prints “Ready — waiting for input” when it starts.\n\nUse the “--verbose” flag to see more output.\n",
    },
    prompt:
      'In docs/guide.md, change the startup message so the sentence says the CLI prints "Ready - listening on port 3000" when it starts. Keep the rest of the file unchanged.',
    check: `${CHECK_PRELUDE}
const text = read("docs/guide.md");
assert.match(text, /listening on port 3000/);
assert.ok(!text.includes("waiting for input"));
assert.ok(text.includes("Use the “--verbose” flag to see more output."), "second paragraph changed");
assert.equal(text.split("\\n").length, 6);
`,
    mock: [
      { tool: "Read", input: { file_path: "docs/guide.md" } },
      {
        tool: "Edit",
        input: {
          file_path: "docs/guide.md",
          // 模型常见写法：直引号 + ASCII 连字符，靠窄归一化匹配
          old_string: 'The CLI prints "Ready - waiting for input" when it starts.',
          new_string: 'The CLI prints "Ready - listening on port 3000" when it starts.',
        },
      },
    ],
  },
  {
    id: "add-function",
    title: "Add and export a new function required by a test",
    files: { "src/strings.js": STRINGS_JS, "test/strings.test.js": STRINGS_TEST },
    prompt:
      "Add and export a `slugify(text)` function in src/strings.js: lowercase, trim, replace every run of non-alphanumeric characters with a single '-', and strip leading/trailing '-'. `node --test` must pass.",
    check: `${CHECK_PRELUDE}
nodeTest();
const { slugify } = await load("src/strings.js");
assert.equal(slugify("  Hello, World!  "), "hello-world");
assert.equal(slugify("a--b__c"), "a-b-c");
assert.equal(slugify("--x--"), "x");
`,
    mock: [
      { tool: "Read", input: { file_path: "src/strings.js" } },
      {
        tool: "Edit",
        input: {
          file_path: "src/strings.js",
          old_string: "  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);\n}",
          new_string:
            '  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);\n}\n\nexport function slugify(text) {\n  return text\n    .toLowerCase()\n    .trim()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}',
        },
      },
    ],
  },
  {
    id: "large-file",
    title: "Targeted edits deep inside a 3000-line file",
    files: { "src/table.js": tableJs() },
    prompt:
      'In src/table.js change MAX_RETRIES from 3 to 5 and change the label of ROW_2750 to "special". The file is large: edit in place, do not rewrite it.',
    check: `${CHECK_PRELUDE}
const mod = await load("src/table.js");
assert.equal(mod.MAX_RETRIES, 5);
assert.equal(mod.ROW_2750.label, "special");
assert.equal(mod.ROW_2749.label, "row 2749");
assert.equal(read("src/table.js").split("\\n").length, 3002);
`,
    mock: [
      { tool: "Read", input: { file_path: "src/table.js", offset: 2595, limit: 170 } },
      {
        tool: "Edit",
        input: {
          file_path: "src/table.js",
          edits: [
            { old_string: "export const MAX_RETRIES = 3;", new_string: "export const MAX_RETRIES = 5;" },
            {
              old_string: 'export const ROW_2750 = { id: 2750, label: "row 2750", weight: 6 };',
              new_string: 'export const ROW_2750 = { id: 2750, label: "special", weight: 6 };',
            },
          ],
        },
      },
    ],
  },
  {
    id: "json-config",
    title: "Structured edit of package.json",
    files: { "package.json": PACKAGE_JSON },
    prompt: 'Bump the version in package.json to 1.5.0 and add a script "lint": "eslint ." next to the existing test script.',
    check: `${CHECK_PRELUDE}
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.version, "1.5.0");
assert.equal(pkg.scripts.lint, "eslint .");
assert.equal(pkg.scripts.test, "node --test");
assert.equal(pkg.name, "demo");
`,
    mock: [
      { tool: "Read", input: { file_path: "package.json" } },
      {
        tool: "Edit",
        input: {
          file_path: "package.json",
          edits: [
            { old_string: '"version": "1.4.2",', new_string: '"version": "1.5.0",' },
            { old_string: '    "test": "node --test"', new_string: '    "test": "node --test",\n    "lint": "eslint ."' },
          ],
        },
      },
    ],
  },
  {
    id: "bom-csv",
    title: "Edit a UTF-8 BOM file and append a row",
    files: { "data/items.csv": "﻿id,name,price\n1,apple,1.20\n2,pear,0.90\n" },
    prompt: "In data/items.csv change the price of pear to 1.10 and add the row `3,plum,2.50` at the end.",
    check: `${CHECK_PRELUDE}
const bytes = readFileSync("data/items.csv");
assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM lost");
assert.equal(bytes.subarray(3).toString("utf8").trim(), "id,name,price\\n1,apple,1.20\\n2,pear,1.10\\n3,plum,2.50");
`,
    mock: [
      { tool: "Read", input: { file_path: "data/items.csv" } },
      { tool: "Edit", input: { file_path: "data/items.csv", old_string: "2,pear,0.90", new_string: "2,pear,1.10\n3,plum,2.50" } },
    ],
  },
];
