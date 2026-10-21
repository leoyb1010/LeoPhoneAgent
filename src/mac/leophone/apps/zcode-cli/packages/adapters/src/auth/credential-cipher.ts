import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { credentialRootSecret } from "./credential-root-key.js";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
/** 钥匙串根密钥加密的新格式。 */
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

export interface ZCodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface ZCodeCredentialCipherOptions {
  env?: Record<string, string | undefined>;
}

export function createZCodeCredentialCipher(
  options: ZCodeCredentialCipherOptions = {},
): ZCodeCredentialCipher {
  const env = options.env ?? process.env;
  const legacyKey = deriveCipherKey(resolveCredentialSecret(env));
  // 与 Host 的 credentialCipherProvider 同一规则：显式 secret 用 v1，否则钥匙串根密钥 v2。
  const rootSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim() ? null : credentialRootSecret(env);
  const v2Key = rootSecret ? deriveCipherKey(`leobot-credential-root:${rootSecret}`) : null;

  return {
    decrypt(value: string): string {
      if (!isEncryptedZCodeCredentialValue(value)) {
        return value;
      }
      const isV2 = value.startsWith(ENCRYPTED_VALUE_PREFIX_V2);
      if (isV2 && !v2Key) {
        throw new Error("Credential decrypt failed: keychain root key unavailable");
      }
      const key = isV2 ? (v2Key as Buffer) : legacyKey;

      const payload = value.slice((isV2 ? ENCRYPTED_VALUE_PREFIX_V2 : ENCRYPTED_VALUE_PREFIX).length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }

      const iv = Buffer.from(ivRaw, "base64url");
      const authTag = Buffer.from(authTagRaw, "base64url");
      const cipherText = Buffer.from(cipherRaw, "base64url");

      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw new Error("Credential decrypt failed: invalid IV length");
      }
      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw new Error("Credential decrypt failed: invalid auth tag length");
      }

      try {
        const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch (error) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error,
        });
      }
    },

    encrypt(value: string): string {
      const key = v2Key ?? legacyKey;
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        v2Key ? ENCRYPTED_VALUE_PREFIX_V2 : ENCRYPTED_VALUE_PREFIX,
        iv.toString("base64url"),
        ".",
        authTag.toString("base64url"),
        ".",
        encrypted.toString("base64url"),
      ].join("");
    },
  };
}

export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX) || value.startsWith(ENCRYPTED_VALUE_PREFIX_V2);
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function resolveCredentialSecret(env: Record<string, string | undefined>): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some packaged or sandboxed runtimes cannot resolve OS user info.
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}
