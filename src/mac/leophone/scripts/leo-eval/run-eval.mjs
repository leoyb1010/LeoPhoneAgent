#!/usr/bin/env node
// LeoPhoneAgent 编码 eval 运行器：每个任务一个临时 git 仓库，经 headless CLI（zcode -p）执行，
// 统计通过率、token（含缓存命中）、工具调用与 Edit 失败。用法见同目录 README.md。
//
//   node scripts/leo-eval/run-eval.mjs --dry-run                 # 本地 mock 模型，不花钱
//   node scripts/leo-eval/run-eval.mjs --models models.json      # 真实模型（自己的 endpoint / key）
//
// 每次运行都用独立的 HOME / 数据目录，不读写你自己的 ~/.leophoneagent，也不带入你的 provider 配置。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { summarizeEvents } from "./lib/events.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";
import { TASKS } from "./tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const leophoneRoot = path.resolve(here, "../..");
const DEFAULT_CLI = path.join(leophoneRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const DEV_ENTRY = path.join(leophoneRoot, "apps/zcode-cli/packages/cli/src/main.ts");
const DEFAULT_TIMEOUT_SECONDS = 900;
const KILL_GRACE_MS = 5_000;

const DRY_RUN_MODELS = [
  { name: "mock (replace)", providerId: "leoeval", modelId: "mock-coder" },
  // 模型名命中 *glm*,再打开 hashlineFamilies → 走 hashline：Read 带 行号#哈希，Edit 用锚点
  { name: "mock (hashline)", providerId: "leoeval", modelId: "mock-glm-4.6", leo: { hashlineFamilies: true } },
];

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      models: { type: "string" },
      tasks: { type: "string" },
      cli: { type: "string" },
      dev: { type: "boolean" },
      out: { type: "string" },
      timeout: { type: "string" },
      "keep-repos": { type: "boolean" },
      "leo-agent": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(await readFile(path.join(here, "README.md"), "utf8"));
    return;
  }
  if (!values["dry-run"] && !values.models) {
    throw new Error("Pass --dry-run (local mock model) or --models <models.json>.");
  }

  const selectedTasks = values.tasks
    ? TASKS.filter((task) => values.tasks.split(",").includes(task.id))
    : TASKS;
  if (selectedTasks.length === 0) throw new Error(`No task matches --tasks ${values.tasks}`);
  const timeoutMs = Number(values.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const command = resolveCliCommand(values);

  let mock;
  let models;
  if (values["dry-run"]) {
    mock = await startMockModelServer({ tasks: TASKS });
    models = DRY_RUN_MODELS.map((model) => ({
      ...model,
      api: { type: "openai-chat-completions", baseUrl: mock.url, apiKey: "dry-run" },
    }));
  } else {
    models = JSON.parse(await readFile(path.resolve(values.models), "utf8"));
  }

  const results = [];
  try {
    for (const model of models) {
      for (const task of selectedTasks) {
        process.stdout.write(`▶ ${model.name} · ${task.id} … `);
        const result = await runTask({
          command,
          dryRun: Boolean(values["dry-run"]),
          keepRepo: Boolean(values["keep-repos"]),
          leoAgent: model.leo ?? (values["leo-agent"] ? JSON.parse(values["leo-agent"]) : undefined),
          model,
          task,
          timeoutMs,
        });
        results.push(result);
        console.log(
          `${result.passed ? "PASS" : "FAIL"} (${(result.durationMs / 1000).toFixed(1)}s, edits ${result.tools.Edit ?? 0}, edit failures ${result.editFailures})`,
        );
      }
    }
  } finally {
    await mock?.close();
  }

  const outPath = path.resolve(
    values.out ?? path.join(here, "results", `eval-${new Date().toISOString().replaceAll(":", "-")}.json`),
  );
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ createdAt: new Date().toISOString(), dryRun: Boolean(values["dry-run"]), results }, null, 2)}\n`);
  console.log(`\n${formatSummary(results)}\nResults: ${outPath}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

function resolveCliCommand(values) {
  if (values.dev) {
    // 源码直跑：其余 workspace 包从各自 dist 加载，改完 core/adapters 等记得先 tsc 构建它们。
    return { file: process.execPath, args: ["--import", "tsx", DEV_ENTRY], cwd: path.dirname(DEV_ENTRY) };
  }
  const cli = path.resolve(values.cli ?? DEFAULT_CLI);
  if (!existsSync(cli)) {
    throw new Error(`CLI not found at ${cli}. Build it (pnpm --filter @zcode/cli build) or pass --cli / --dev.`);
  }
  return { file: process.execPath, args: [cli], cwd: undefined };
}

async function runTask({ command, dryRun, keepRepo, leoAgent, model, task, timeoutMs }) {
  const root = await mkdtemp(path.join(os.tmpdir(), `leo-eval-${task.id}-`));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const startedAt = Date.now();
  try {
    await createRepo(repo, task.files);
    await mkdir(home, { recursive: true });
    const providerConfigPath = path.join(root, "provider_config.json");
    await writeFile(providerConfigPath, JSON.stringify(providerConfig(model, dryRun ? task.id : undefined), null, 2));

    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ZCODE_DATA_BASE_DIR: home,
      ZCODE_STORAGE_DIR: path.join(home, ".leophoneagent"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfigPath,
      ...(leoAgent ? { ZCODE_LEO_AGENT: JSON.stringify(leoAgent) } : {}),
      ...model.env,
    };
    const run = await runCli({
      command,
      env,
      prompt: task.prompt,
      repo,
      timeoutMs,
    });
    const summary = summarizeEvents(run.stdout);
    const check = runCheck(root, repo, task.check);
    return {
      task: task.id,
      model: model.name,
      modelId: model.modelId,
      passed: run.exitCode === 0 && check.passed,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: Date.now() - startedAt,
      check: check.passed ? "passed" : check.output.slice(-2000),
      ...summary,
      stderrTail: run.exitCode === 0 ? undefined : run.stderr.slice(-2000),
      ...(keepRepo ? { repo } : {}),
    };
  } finally {
    if (!keepRepo) await rm(root, { recursive: true, force: true });
  }
}

async function createRepo(repo, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repo, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=leo-eval", "-c", "user.email=leo-eval@localhost", "-c", "core.autocrlf=false", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "task setup");
}

function providerConfig(model, dryRunTaskId) {
  const apiKey = model.api.apiKey ?? (model.api.apiKeyEnv ? process.env[model.api.apiKeyEnv] : undefined);
  if (!apiKey) throw new Error(`No API key for ${model.name}: set api.apiKey or api.apiKeyEnv.`);
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: model.providerId,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey },
              api: {
                type: model.api.type ?? "openai-chat-completions",
                baseUrl: model.api.baseUrl,
                ...(dryRunTaskId ? { headers: { "x-leo-eval-task": dryRunTaskId } } : {}),
              },
              personalModelIds: [model.modelId],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: {
        providerId: model.providerId,
        modelId: model.modelId,
        options: { reasoningLevel: model.reasoningLevel ?? "disabled" },
      },
    },
  };
}

function runCli({ command, env, prompt, repo, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(
      command.file,
      [...command.args, "-p", prompt, "--output-format", "stream-json", "--mode", "yolo", "--cwd", repo],
      { cwd: command.cwd ?? repo, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr, timedOut });
    });
  });
}

function runCheck(root, repo, source) {
  // 检查脚本放在仓库外：agent 看不到、也改不到它。
  const checkPath = path.join(root, "check.mjs");
  writeFileSync(checkPath, source);
  const result = spawnSync(process.execPath, [checkPath], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  return { passed: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function formatSummary(results) {
  const byModel = new Map();
  for (const result of results) {
    const row = byModel.get(result.model) ?? { passed: 0, total: 0, input: 0, output: 0, cacheRead: 0, edits: 0, editFailures: 0 };
    row.total += 1;
    if (result.passed) row.passed += 1;
    row.input += result.usage?.inputTokens ?? 0;
    row.output += result.usage?.outputTokens ?? 0;
    row.cacheRead += result.usage?.cacheReadTokens ?? 0;
    row.edits += result.tools.Edit ?? 0;
    row.editFailures += result.editFailures;
    byModel.set(result.model, row);
  }
  const lines = ["| model | pass | input tok | output tok | cache read | Edit calls | Edit failures |", "|---|---|---|---|---|---|---|"];
  for (const [model, row] of byModel) {
    lines.push(`| ${model} | ${row.passed}/${row.total} | ${row.input} | ${row.output} | ${row.cacheRead} | ${row.edits} | ${row.editFailures} |`);
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
