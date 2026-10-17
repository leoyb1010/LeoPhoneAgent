#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runPnpm(args) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

runCommand("git", ["submodule", "update", "--init", "--recursive", "apps/zcode-cli"], {
  cwd: rootDir,
  env: process.env,
});

runPnpm(["install"]);
runPnpm(["prepare:desktop-runtime"]);
runPnpm(["run", "build:bootstrap"]);
