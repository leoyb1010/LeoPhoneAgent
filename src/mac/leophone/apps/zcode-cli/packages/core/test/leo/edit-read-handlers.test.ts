// [leo] Edit / Read handler 端到端：真实文件系统 adapter + 临时目录。
// 覆盖 CRLF / BOM 保留、read-before-edit、同文件并发编辑排队、策略计数、按模型的 hashline 与无行号 Read。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Model } from "@zcode/contracts";
import { NodeFileSystemAdapter } from "../../../adapters/src/fs/index.js";
import { editToolEntry } from "../../src/tool/handlers/edit.js";
import { readToolEntry } from "../../src/tool/handlers/read.js";
import { getLeoEditMatchStats, resetLeoEditMatchStats } from "../../src/tool/leo/edit-match-stats.js";
import { parseHashlineAnchor } from "../../src/tool/leo/hashline.js";
import type { LeoAgentSettings } from "../../src/tool/leo/model-profile.js";
import { withLeoModelProfile } from "../../src/tool/leo/tool-profile.js";
import type { ToolEntry, ToolExecutionContext } from "../../src/tool/types.js";

const fakeModel = (providerId: string, modelId: string): Model =>
  ({ providerId, modelId, properties: { inputFormat: { supportsPdf: false, supportsImage: true } } }) as unknown as Model;
const GLM = fakeModel("zai", "glm-4.6");
const CLAUDE = fakeModel("anthropic", "claude-sonnet-4-5");

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-edit-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createContext(dir: string, model?: Model, shared?: ToolExecutionContext): ToolExecutionContext {
  let callId = 0;
  return {
    toolCallId: `call-${(callId += 1)}`,
    traceId: "trace-leo" as ToolExecutionContext["traceId"],
    abortSignal: new AbortController().signal,
    fileSystemPort: shared?.fileSystemPort ?? new NodeFileSystemAdapter(),
    workingDirectory: dir,
    workspaceRoot: dir,
    sessionId: "session-leo" as ToolExecutionContext["sessionId"],
    readFileState: shared?.readFileState ?? new Map(),
    ...(model ? { model } : {}),
  };
}

function entries(settings?: LeoAgentSettings): { edit: ToolEntry; read: ToolEntry } {
  return {
    edit: withLeoModelProfile(editToolEntry, settings),
    read: withLeoModelProfile(readToolEntry, settings),
  };
}

async function readForModel(entry: ToolEntry, context: ToolExecutionContext, input: Record<string, unknown>): Promise<string> {
  const output = await entry.handler(input, context);
  const content = entry.formatModelContent!(output);
  assert.equal(typeof content, "string");
  return content as string;
}

test("multi edit keeps CRLF line endings and the UTF-8 BOM", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "crlf.txt");
    await writeFile(file, "﻿line one\r\nline two\r\nline three\r\n");
    const { edit, read } = entries();
    const context = createContext(dir, CLAUDE);
    await read.handler({ file_path: file }, context);
    const output = (await edit.handler(
      { file_path: file, edits: [{ old_string: "line one", new_string: "first" }, { old_string: "line three", new_string: "third" }] },
      context,
    )) as { leo?: { editCount: number } };
    assert.equal(output.leo?.editCount, 2);
    const bytes = await readFile(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).toString("utf8"), "first\r\nline two\r\nthird\r\n");
  });
});

test("single legacy edit through a loose matcher on line 1 no longer drops the BOM", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "bom.ts");
    await writeFile(file, "﻿  alpha();\n  beta();\n");
    const { edit, read } = entries();
    const context = createContext(dir, CLAUDE);
    await read.handler({ file_path: file }, context);
    const output = (await edit.handler(
      { file_path: file, old_string: "alpha();\nbeta();", new_string: "  gamma();\n  delta();" },
      context,
    )) as { matchStrategy?: string };
    assert.equal(output.matchStrategy, "line_trimmed");
    assert.equal(await readFile(file, "utf8"), "﻿  gamma();\n  delta();\n");
  });
});

test("multi edit still requires a prior Read and reports all problems at once", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "one\ntwo\n");
    const { edit, read } = entries();
    const context = createContext(dir, CLAUDE);
    const unread = (await edit.handler(
      { file_path: file, edits: [{ old_string: "one", new_string: "1" }, { old_string: "two", new_string: "2" }] },
      context,
    )) as { result?: boolean; errorCode?: number };
    assert.equal(unread.result, false);
    assert.equal(unread.errorCode, 6);

    await read.handler({ file_path: file }, context);
    const failure = (await edit.handler(
      { file_path: file, edits: [{ old_string: "missing", new_string: "x" }, { old_string: "nope", new_string: "y" }] },
      context,
    )) as { message?: string };
    assert.match(failure.message ?? "", /edits\[0\][\s\S]*edits\[1\]/u);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\n");
  });
});

test("parallel edits of the same file are queued instead of colliding", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "parallel.txt");
    await writeFile(file, "a = 1\nb = 2\nc = 3\n");
    const { edit, read } = entries();
    const context = createContext(dir, CLAUDE);
    await read.handler({ file_path: file }, context);
    const results = await Promise.all([
      edit.handler({ file_path: file, old_string: "a = 1", new_string: "a = 10" }, createContext(dir, CLAUDE, context)),
      edit.handler({ file_path: file, old_string: "c = 3", new_string: "c = 30" }, createContext(dir, CLAUDE, context)),
    ]);
    for (const result of results) assert.notEqual((result as { result?: boolean }).result, false);
    assert.equal(await readFile(file, "utf8"), "a = 10\nb = 2\nc = 30\n");
  });
});

test("match strategies are counted per applied edit", async () => {
  await withTempDir(async (dir) => {
    resetLeoEditMatchStats();
    const file = path.join(dir, "quotes.md");
    await writeFile(file, "He said “hi” — twice.\nplain line\n");
    const { edit, read } = entries();
    const context = createContext(dir, CLAUDE);
    await read.handler({ file_path: file }, context);
    await edit.handler(
      { file_path: file, edits: [{ old_string: 'He said "hi" - twice.', new_string: "He said “bye”." }, { old_string: "plain line", new_string: "plain" }] },
      context,
    );
    assert.deepEqual(getLeoEditMatchStats(), { exact: 1, unicode_normalized: 1 });
    assert.equal(await readFile(file, "utf8"), "He said “bye”.\nplain\n");
  });
});

test("GLM gets hashline Read + anchored Edit; Claude keeps cat -n and the replace schema", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "code.ts");
    await writeFile(file, "export function f() {\n  return 1;\n}\n");
    const { edit, read } = entries({ hashlineFamilies: true });

    const glmContract = edit.resolveModelContract!({ model: GLM });
    assert.match(JSON.stringify(glmContract.inputSchema), /"pos"/u);
    assert.match(read.resolveModelContract!({ model: GLM }).description ?? "", /LINE#HASH/u);
    const claudeContract = edit.resolveModelContract!({ model: CLAUDE });
    assert.doesNotMatch(JSON.stringify(claudeContract.inputSchema), /"pos"/u);
    assert.match(read.resolveModelContract!({ model: CLAUDE }).description ?? "", /cat -n/u);

    const claudeView = await readForModel(read, createContext(dir, CLAUDE), { file_path: file });
    assert.ok(claudeView.startsWith("1\texport function f() {"));

    const context = createContext(dir, GLM);
    const view = await readForModel(read, context, { file_path: file });
    const lines = view.split("\n");
    assert.match(lines[0]!, /^1#[ZPMQVRWSNKTXJBYH]{2}:export function f\(\) \{$/u);
    const returnAnchor = lines[1]!.slice(0, lines[1]!.indexOf(":"));
    const output = await edit.handler(
      { file_path: file, edits: [{ op: "replace", pos: returnAnchor, lines: ["  return 2;"] }, { op: "append", lines: ["// end"] }] },
      context,
    );
    const message = edit.formatModelContent!(output) as string;
    assert.match(message, /2 edits applied/u);
    assert.match(message, /Current anchors around the change/u);
    assert.equal(await readFile(file, "utf8"), "export function f() {\n  return 2;\n}\n// end\n");
    const previewAnchor = message.split("\n").find((line) => line.endsWith(":  return 2;"));
    assert.ok(previewAnchor && parseHashlineAnchor(previewAnchor)?.line === 2);
  });
});

test("settings override the family default: GLM forced to replace, Claude forced to hashline", async () => {
  const { edit } = entries({ hashlineFamilies: true, editMode: { models: { "*glm*": "replace", "claude-*": "hashline" } } });
  assert.doesNotMatch(JSON.stringify(edit.resolveModelContract!({ model: GLM }).inputSchema), /"pos"/u);
  assert.match(JSON.stringify(edit.resolveModelContract!({ model: CLAUDE }).inputSchema), /"pos"/u);
});

test("plain Read: no line numbers, 2000-line / 50KB whole-line windows with a continuation hint", async () => {
  await withTempDir(async (dir) => {
    const settings: LeoAgentSettings = { readLineNumbers: { default: false } };
    const { edit, read } = entries(settings);
    const context = createContext(dir, CLAUDE);

    const many = path.join(dir, "many.txt");
    await writeFile(many, Array.from({ length: 3000 }, (_, index) => `row ${index + 1}`).join("\n"));
    const first = await readForModel(read, context, { file_path: many });
    assert.ok(first.startsWith("row 1\nrow 2\n"));
    assert.match(first, /\[Showing lines 1-2000 of 3000\. Use offset=2001 to continue\.\]$/u);
    const next = await readForModel(read, context, { file_path: many, offset: 2001 });
    assert.ok(next.startsWith("row 2001\n") && next.endsWith("row 3000"));

    const wide = path.join(dir, "wide.txt");
    await writeFile(wide, Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(1000, "x")).join("\n"));
    const wideView = await readForModel(read, context, { file_path: wide });
    const shown = wideView.split("\n\n[Showing")[0]!.split("\n");
    assert.equal(shown.length, 51);
    assert.ok(shown.every((line) => line.length === 1000));
    assert.match(wideView, /Use offset=52 to continue/u);

    const huge = path.join(dir, "huge.txt");
    await writeFile(huge, `${"y".repeat(60 * 1024)}\nsmall\n`);
    assert.match(await readForModel(read, context, { file_path: huge }), /Line 1 is 60KB/u);

    // 窗口读过的文件可以直接编辑（range view，不是 partial view）
    const output = await edit.handler({ file_path: many, old_string: "row 10\n", new_string: "row ten\n" }, context);
    assert.notEqual((output as { result?: boolean }).result, false);
  });
});

test("hashline: re-reading after an Edit returns fresh anchors instead of the 'file unchanged' stub", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "shift.ts");
    await writeFile(file, "one\ntwo\nthree\n");
    const { edit, read } = entries({ hashlineFamilies: true });

    const glm = createContext(dir, GLM);
    await read.handler({ file_path: file }, glm);
    const single = await edit.handler({ file_path: file, old_string: "one", new_string: "zero\none" }, glm);
    assert.match(edit.formatModelContent!(single) as string, /Current anchors around the change[\s\S]*1#[A-Z]{2}:zero/u);
    const reread = await readForModel(read, glm, { file_path: file });
    assert.match(reread, /^1#[A-Z]{2}:zero\n2#[A-Z]{2}:one\n3#[A-Z]{2}:two/u);

    // replace 模式保持上游行为：编辑后重读同一文件得到占位提示
    const claude = createContext(dir, CLAUDE);
    await read.handler({ file_path: file }, claude);
    await edit.handler({ file_path: file, old_string: "zero\n", new_string: "" }, claude);
    assert.match(await readForModel(read, claude, { file_path: file }), /file unchanged since your last Read/u);
  });
});
