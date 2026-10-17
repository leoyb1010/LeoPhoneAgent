import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const exec = promisify(execFile);
const runnerSource = new URL("./zcode-distribution/runner.mjs", import.meta.url);

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-distribution-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "zcode");
  for (const name of ["bin", "agent"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  await cp(runnerSource, join(root, "bin/zcode.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  await writeFile(
    join(root, "agent/zcode.cjs"),
    `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd() }));
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
`,
  );
  return { directory, root, runner: join(root, "bin/zcode.mjs") };
}

test("default launch and CLI arguments reuse the Agent entry", async (t) => {
  const { runner, root, directory } = await fixture(t);
  for (const args of [[], ["tui"], ["--prompt", "--web"], ["app-server", "--stdio"]]) {
    const result = await exec(process.execPath, [runner, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: args,
      entry: join(root, "agent/zcode.cjs"),
      cwd: directory,
    });
  }
  await assert.rejects(
    exec(process.execPath, [runner], { env: { ...process.env, FIXTURE_EXIT_CODE: "17" } }),
    (error) => error.code === 17,
  );
});

test("help is forwarded to the CLI; version uses the distribution", async (t) => {
  const { runner } = await fixture(t);
  assert.equal((await exec(process.execPath, [runner, "--version"])).stdout.trim(), "1.2.3");
  const help = (await exec(process.execPath, [runner, "--help"])).stdout;
  assert.match(help, /"argv":\["--help"\]/);
});

test("installer creates zcode and the installed command defaults to CLI", async (t) => {
  const { directory, root } = await fixture(t);
  const downloads = join(directory, "downloads");
  const releaseDir = join(downloads, "releases/1.2.3");
  await mkdir(releaseDir, { recursive: true });
  await exec("tar", ["-czf", join(releaseDir, "zcode-1.2.3.tar.gz"), "-C", directory, "zcode"]);
  await writeFile(
    join(downloads, "latest.json"),
    JSON.stringify({ version: "1.2.3", tarball: "zcode-1.2.3.tar.gz" }),
  );
  const installer = join(directory, "install.sh");
  await writeFile(installer, installScriptSource(`file://${downloads}/`));
  const installRoot = join(directory, "installed");
  const bin = join(directory, "bin");
  await exec("sh", [installer], {
    env: {
      ...process.env,
      ZCODE_DIST_BASE_URL: `file://${downloads}/`,
      ZCODE_DIST_HOME: installRoot,
      ZCODE_DIST_BIN_DIR: bin,
    },
  });
  await rm(root, { recursive: true });
  const result = await exec(join(bin, "zcode"), [], { cwd: directory });
  assert.deepEqual(JSON.parse(result.stdout).argv, []);
});
