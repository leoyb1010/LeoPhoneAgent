import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { record } from "./linkPolicy.js";

/**
 * [e2e] 经中继的请求端到端加密（docs/specs/leo-link-e2e.md）。
 * 手机每个请求现生成一把 X25519 临时钥匙，和这台 Mac 的静态钥匙做 ECDH，HKDF 出两把方向钥匙；
 * 中继只看到 /e2e、/e2e/events 和密文。手机侧见 iOS Shared/RelayE2E.swift，两边线格式必须逐字节一致。
 */
const INFO = Buffer.from("leobot-relay-e2e-v1");
const AAD_REQ = Buffer.from("leobot-e2e-req");
const AAD_RESP = Buffer.from("leobot-e2e-resp");
// X25519 原始 32 字节 ↔ DER：node 只能经 PKCS8 / SPKI 导入原始钥匙。
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** 见过的临时公钥：中继把同一个信封重放给 Mac 时直接拒绝。进程内有效，重启后 POST 仍由操作回执按 request_id 去重。 */
const SEEN_LIMIT = 20_000;

export type E2EKeys = { req: Buffer; resp: Buffer };

export function privateKeyFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" })).subarray(SPKI_PREFIX.length);
}

/** salt = 临时公钥 ‖ Mac 公钥；前 32 字节手机→Mac，后 32 字节 Mac→手机。 */
export function deriveKeys(privateKey: KeyObject, peerPublic: Buffer, ephemeralPublic: Buffer, macPublic: Buffer): E2EKeys {
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublic) });
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, macPublic]), INFO, 64));
  return { req: okm.subarray(0, 32), resp: okm.subarray(32) };
}

/** nonce = 4 个零字节 ‖ 64 位大端计数。请求固定 0；响应 0；流的第 n 帧用 n。 */
function nonce(counter: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(counter), 4);
  return out;
}

export function seal(key: Buffer, counter: number, plaintext: Buffer, aad: Buffer): string {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce(counter), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

export function unseal(key: Buffer, counter: number, sealed: string, aad: Buffer): Buffer {
  const data = Buffer.from(sealed, "base64url");
  if (data.length < 16) throw new Error("e2e ciphertext too short");
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce(counter), { authTagLength: 16 });
  decipher.setAAD(aad, { plaintextLength: data.length - 16 });
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

export const sealRequest = (keys: E2EKeys, plaintext: Buffer) => seal(keys.req, 0, plaintext, AAD_REQ);
export const sealResponse = (keys: E2EKeys, counter: number, plaintext: Buffer) =>
  seal(keys.resp, counter, plaintext, AAD_RESP);

/** 读这台 Mac 的静态钥匙；没有就生成（0600，并发首启只认先发布的那把）。 */
export async function loadRelayE2EKey(file: string): Promise<KeyObject> {
  const read = async () => {
    const value = record(JSON.parse(await readFile(file, "utf8")));
    const raw = Buffer.from(String(value["private_key"] ?? ""), "base64url");
    if (value["v"] !== 1 || raw.length !== 32) throw new Error("Invalid relay e2e key file");
    return privateKeyFromRaw(raw);
  };
  try {
    return await read();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("x25519");
  const raw = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(PKCS8_PREFIX.length);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: 1, private_key: raw.toString("base64url") }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // 与 deviceIdentity 同法:link 不覆盖已有文件,并发首启的输家读胜者那把。
      await link(temporary, file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    return await read();
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 内层请求 / 响应与 bridge 的 LinkRequest / LinkResponse 同形；不反向 import bridge，免得成环。 */
export type E2EInner = { method: string; path: string; body?: unknown; requestId?: string };
type Inner = E2EInner;
type Logger = { warn: (msg: string, meta?: unknown) => void };
type LinkResponse = { status: number; body: unknown };

function rejected(message: string, status = 400): LinkResponse {
  // 明文错误只说「解不开」，不含任何业务内容；手机见到 e2e_rejected 就退回明文路径。
  return { status, body: { error: { code: status === 409 ? "e2e_replay" : "e2e_rejected", message } } };
}

export class RelayE2E {
  readonly publicKey: Buffer;
  /** base64url，放进配对码与 capabilities。 */
  readonly publicKeyText: string;
  private readonly seen = new Set<string>();

  constructor(private readonly privateKey: KeyObject) {
    this.publicKey = rawPublicKey(privateKey);
    this.publicKeyText = this.publicKey.toString("base64url");
  }

  /** 解开一个信封；k = 临时公钥，c = 密文。失败返回 null（不区分原因，免得给中继当解密预言机）。 */
  private openEnvelope(k: unknown, c: unknown): { keys: E2EKeys; inner: Record<string, unknown>; ephemeral: string } | null {
    if (typeof k !== "string" || typeof c !== "string" || c.length > 4 * 1024 * 1024) return null;
    try {
      const ephemeral = Buffer.from(k, "base64url");
      if (ephemeral.length !== 32) return null;
      const keys = deriveKeys(this.privateKey, ephemeral, ephemeral, this.publicKey);
      const inner = record(JSON.parse(unseal(keys.req, 0, c, AAD_REQ).toString("utf8")));
      return { keys, inner, ephemeral: k };
    } catch {
      return null;
    }
  }

  private fresh(ephemeral: string): boolean {
    if (this.seen.has(ephemeral)) return false;
    this.seen.add(ephemeral);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private static inner(value: Record<string, unknown>): Inner | null {
    const method = String(value["method"] ?? "GET").toUpperCase();
    const target = String(value["path"] ?? "");
    // 只能套一层；内层路径交给 bridge.handle 照常过白名单。
    if (!target.startsWith("/") || target.startsWith("/e2e")) return null;
    const requestId = typeof value["request_id"] === "string" && value["request_id"] ? value["request_id"] : undefined;
    return { method, path: target, body: value["body"], ...(requestId ? { requestId } : {}) };
  }

  /** POST /e2e：解密 → 交给 bridge.handle → 把 {status, body} 加密回去；外层状态码照抄内层，中继排队回执才知道 Mac 拒没拒。 */
  async handle(body: unknown, next: (inner: Inner) => Promise<LinkResponse>): Promise<LinkResponse> {
    const envelope = record(body);
    const opened = envelope["v"] === 1 ? this.openEnvelope(envelope["k"], envelope["c"]) : null;
    if (!opened) return rejected("e2e envelope rejected");
    if (!this.fresh(opened.ephemeral)) return rejected("e2e envelope replayed", 409);
    const inner = RelayE2E.inner(opened.inner);
    if (!inner) return rejected("e2e inner request rejected");
    let result: LinkResponse;
    try {
      result = await next(inner);
    } catch (cause) {
      result = { status: 500, body: { error: { message: cause instanceof Error ? cause.message : String(cause) } } };
    }
    const plaintext = Buffer.from(JSON.stringify({ status: result.status, body: result.body ?? null }));
    // 204 / 304 不能带正文：外层改 200，真实状态在密文里。
    const status = result.status === 204 || result.status === 304 ? 200 : result.status;
    return { status, body: { v: 1, c: sealResponse(opened.keys, 0, plaintext) } };
  }

  /**
   * GET /e2e/events?v=1&k=&c=：第 0 帧是加密的 {"type":"e2e.open"}，之后每条 data 依次用计数 1、2、3… 加密。
   * 解不开就一帧都不发：手机没等到第 0 帧就退回明文。
   */
  async stream(
    query: URLSearchParams,
    next: (inner: Inner, write: (data: string) => void) => Promise<void>,
    write: (data: string) => void,
  ): Promise<void> {
    if (query.get("v") !== "1") return;
    const opened = this.openEnvelope(query.get("k"), query.get("c"));
    if (!opened || !this.fresh(opened.ephemeral)) return;
    const inner = RelayE2E.inner(opened.inner);
    if (!inner || inner.method !== "GET") return;
    let counter = 0;
    const emit = (data: string) =>
      write(JSON.stringify({ v: 1, c: sealResponse(opened.keys, counter++, Buffer.from(data)) }));
    emit(JSON.stringify({ type: "e2e.open" }));
    await next(inner, emit);
  }
}

/** 这台 Mac 的那一把(钥匙文件不随连接重启而变);配对码要用它的公钥。 */
let current: RelayE2E | undefined;

export function relayE2EPublicKey(): string | undefined {
  return current?.publicKeyText;
}

/** 读不出钥匙就不开 e2e(手机照旧走明文);钥匙文件坏了不自动重建,免得已固定旧公钥的手机全部退回明文。 */
export async function loadRelayE2E(file: string, logger: Logger): Promise<RelayE2E | undefined> {
  try {
    current = new RelayE2E(await loadRelayE2EKey(file));
  } catch (cause) {
    current = undefined;
    logger.warn("[leo/link] relay e2e key unavailable; relay stays plaintext", { error: String(cause) });
  }
  return current;
}
