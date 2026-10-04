import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import * as runtime from "./embedded-postgres-native.js";

const require = createRequire(import.meta.url);

describe("Darwin embedded Postgres library aliases", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });
  const directory = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "pc-dylib-"));
    temporary.push(value);
    return value;
  };

  it("creates loader aliases for ICU and multi-component library versions", async () => {
    const lib = directory();
    fs.writeFileSync(path.join(lib, "libicudata.77.1.dylib"), "fixture");
    fs.writeFileSync(path.join(lib, "liblz4.1.10.0.dylib"), "fixture");
    fs.writeFileSync(path.join(lib, "libcrypto.3.dylib"), "fixture");
    fs.writeFileSync(path.join(lib, "README.md"), "fixture");
    expect((await runtime.ensureDarwinSharedLibraryAliases(lib)).map(value => path.basename(value)).sort())
      .toEqual(["libcrypto.dylib", "libicudata.77.dylib", "libicudata.dylib", "liblz4.1.dylib", "liblz4.dylib"]);
    expect(fs.readlinkSync(path.join(lib, "liblz4.1.dylib"))).toBe("liblz4.1.10.0.dylib");
    expect(await runtime.ensureDarwinSharedLibraryAliases(lib)).toEqual([]);
  });

  it("preserves an existing major alias rather than replacing operator intent", async () => {
    const lib = directory();
    fs.writeFileSync(path.join(lib, "libicuuc.77.1.dylib"), "fixture");
    fs.writeFileSync(path.join(lib, "libicuuc.77.dylib"), "existing");
    expect((await runtime.ensureDarwinSharedLibraryAliases(lib)).map(value => path.basename(value))).toEqual(["libicuuc.dylib"]);
    expect(fs.readFileSync(path.join(lib, "libicuuc.77.dylib"), "utf8")).toBe("existing");
  });

  it.runIf(process.platform === "darwin")("prepares bundled Darwin initdb and postgres for actual execution", async () => {
    await runtime.prepareEmbeddedPostgresNativeRuntime();
    const packageRoot = path.dirname(path.dirname(require.resolve("embedded-postgres")));
    const nativeRoot = path.resolve(packageRoot, "..", "@embedded-postgres", `darwin-${process.arch}`, "native");
    for (const name of ["libicudata.77.dylib", "libicuuc.77.dylib", "libicui18n.77.dylib"]) {
      expect(fs.existsSync(path.join(nativeRoot, "lib", name))).toBe(true);
    }
    const version = childProcess.execFileSync(path.join(nativeRoot, "bin", "initdb"), ["--version"], { encoding: "utf8" });
    expect(version).toMatch(/^initdb \(PostgreSQL\) 18\.1/);
    expect(childProcess.execFileSync(path.join(nativeRoot, "bin", "postgres"), ["--version"], { encoding: "utf8" }))
      .toMatch(/^postgres \(PostgreSQL\) 18\.1/);
  });
});
