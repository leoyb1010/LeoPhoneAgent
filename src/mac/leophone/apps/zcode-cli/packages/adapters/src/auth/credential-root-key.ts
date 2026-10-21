import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";

/**
 * [leo] 凭据加密的根密钥：随机 32 字节，放在 macOS 钥匙串里。
 *
 * 以前没设 ZCODE_CREDENTIAL_SECRET 时，密钥 = sha256(平台:家目录:用户名)。拿到 credentials.json
 * 副本的人照着这三个公开信息就能重建密钥。现在新写入一律用钥匙串里的随机根密钥（enc:v2），
 * 旧的 enc:v1 照常能读，下次保存时自动换成 v2。
 *
 * 与 packages/services/src/credential/providers/credentialRootKey.ts 必须保持一致：两边读同一份文件。
 * 走 /usr/bin/security 命令行（与中继机器钥匙同一做法），所以 Host、CLI 子进程读写都不会弹授权框。
 * 测试进程（LEO_TEST_HOME）与显式配置了 ZCODE_CREDENTIAL_SECRET 的环境不碰钥匙串。
 */
export const CREDENTIAL_ROOT_SERVICE = "LeoBot Credential Root";
const ACCOUNT = "default";
const SECURITY = "/usr/bin/security";

let cached: string | null | undefined;

function readItem(): string | null {
  const result = spawnSync(SECURITY, ["find-generic-password", "-s", CREDENTIAL_ROOT_SERVICE, "-a", ACCOUNT, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout ?? "").trim();
  return value.length >= 32 ? value : null;
}

function addItem(secret: string): boolean {
  // 密钥走 stdin（security -i），不出现在进程参数里。不带 -U：两个进程同时首次生成时先写者赢，后者重读。
  const result = spawnSync(SECURITY, ["-i"], {
    input: `add-generic-password -s "${CREDENTIAL_ROOT_SERVICE}" -a "${ACCOUNT}" -w "${secret}"\n`,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 5_000,
  });
  return result.status === 0;
}

export function keychainRootUsable(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  if (platform() !== "darwin") return false;
  if (env["LEO_TEST_HOME"]) return false;
  if (env["LEO_CREDENTIAL_KEYCHAIN"] === "0") return false;
  return true;
}

/** 读或首次生成根密钥；钥匙串不可用时返回 null（调用方退回旧派生）。 */
export function credentialRootSecret(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null {
  if (!keychainRootUsable(env)) return null;
  if (cached !== undefined) return cached;
  let secret = readItem();
  if (!secret) {
    const fresh = randomBytes(32).toString("base64url");
    addItem(fresh);
    secret = readItem();
  }
  cached = secret;
  return secret;
}
