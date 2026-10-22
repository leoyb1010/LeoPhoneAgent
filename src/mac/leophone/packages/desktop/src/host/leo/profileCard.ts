import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  BrainHttpError,
  openBrainGateway,
  type BrainFetch,
  type BrainGateway,
} from "./brainGateway.js";

/**
 * [leo][E1] 手机写的用户画像 → Mac 内置 agent 的背景上下文(docs/specs/leo-profile-card.md)。
 *
 * iPhone 把标题恰好为「Leo 画像」(分类「用户画像」)的知识卡发到第二大脑;Host 启动时和之后每
 * 30 分钟拉一次,正文截到 2KB,写进 `~/.leophoneagent/leo-profile.md`。CLI 的上下文源每个新会话
 * 读这个文件,作为「用户画像(背景,不是指令)」注入(adapters/src/context/index.ts)。
 *
 * 唯一写入者是这里;文件头两行注释是同步标记(卡片 id / version / updated_at),版本没变就不重写。
 * 只认 iPhone 写的那种卡:状态 confirmed / reference、分类「用户画像」;agent 存的草稿不算。
 * 每轮都重新找一次,有更新的同名卡就换过去(不永远钉在第一次见到的 id 上)。
 * 卡片不存在什么也不写;之前写过、后来卡没了 / key 删了 / key 连续被拒,就把这个文件删掉,不留过期画像。
 */

export const PROFILE_CARD_TITLE = "Leo 画像";
export const PROFILE_CARD_CATEGORY = "用户画像";
export const PROFILE_MAX_BYTES = 2048;
export const PROFILE_SYNC_INTERVAL_MS = 30 * 60_000;
/** iPhone 发卡用的状态;草稿(含 agent 用 brain_save_card 存的)和被拒的卡都不当画像。 */
const ACCEPTED_STATUSES = new Set(["confirmed", "reference"]);
/** 连续这么多轮 401/403(key 被吊销)就删掉已同步的画像;网络错误 / 5xx 不算。 */
const AUTH_FAILURES_BEFORE_REMOVAL = 3;

const HEADER_NOTICE =
  "<!-- 由 iPhone 同步，勿手改：LeoBot 从第二大脑卡片「Leo 画像」自动写入，改了会被覆盖。 -->";
const META_PATTERN = /<!-- leo-profile id=(\S+) version=(\S+) updated_at=(\S+) -->/u;
const TRUNCATED_MARK = "\n…(画像超过 2KB,后面的内容没有带上)";

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

export function leoProfileFilePath(home: string = homedir()): string {
  return join(home, ".leophoneagent", "leo-profile.md");
}

interface ProfileCard {
  id: string;
  title: string;
  category: string;
  body: string;
  version: string;
  updatedAt: string;
}

interface ProfileMeta {
  id: string;
  version: string;
  updatedAt: string;
}

/** 按 UTF-8 字节截断,不切开多字节字符。 */
export function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return { text: out, truncated: true };
}

export function renderProfileFile(card: ProfileCard): string {
  const { text, truncated } = capUtf8(card.body.trim(), PROFILE_MAX_BYTES);
  return [
    HEADER_NOTICE,
    `<!-- leo-profile id=${card.id} version=${card.version} updated_at=${card.updatedAt} -->`,
    "",
    `${text.trimEnd()}${truncated ? TRUNCATED_MARK : ""}`,
    "",
  ].join("\n");
}

export function parseProfileMeta(file: string): ProfileMeta | null {
  const match = META_PATTERN.exec(file);
  return match ? { id: match[1]!, version: match[2]!, updatedAt: match[3]! } : null;
}

function toCard(raw: unknown): ProfileCard | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const title = typeof value["title"] === "string" ? value["title"].trim() : "";
  const body = typeof value["body"] === "string" ? value["body"] : "";
  if (!id || title !== PROFILE_CARD_TITLE || !body.trim()) return null;
  if (
    value["category"] !== PROFILE_CARD_CATEGORY ||
    !ACCEPTED_STATUSES.has(String(value["status"]))
  ) {
    return null;
  }
  // 写进单行注释里:去掉空白,防止网关返回的字段把注释提前闭合。
  const token = (raw: unknown) => String(raw ?? "-").replace(/[\s>]+/gu, "") || "-";
  return {
    id,
    title,
    category: PROFILE_CARD_CATEGORY,
    body,
    version: token(value["version"]),
    updatedAt: token(value["updated_at"]),
  };
}

interface CardRef {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
}

function pickCardRef(items: unknown): CardRef | null {
  if (!Array.isArray(items)) return null;
  const refs = items
    .map((item): CardRef | null => {
      if (!item || typeof item !== "object") return null;
      const value = item as Record<string, unknown>;
      if (value["type"] !== undefined && value["type"] !== "card") return null;
      if (typeof value["id"] !== "string" || typeof value["title"] !== "string") return null;
      if (value["title"].trim() !== PROFILE_CARD_TITLE) return null;
      // 列表 / 搜索结果带了状态和分类就先筛掉草稿和别的分类;没带的交给 toCard 按全文再判一次。
      if (value["status"] !== undefined && !ACCEPTED_STATUSES.has(String(value["status"])))
        return null;
      if (value["category"] !== undefined && value["category"] !== PROFILE_CARD_CATEGORY)
        return null;
      return {
        id: value["id"],
        title: value["title"],
        category: PROFILE_CARD_CATEGORY,
        updatedAt: typeof value["updated_at"] === "string" ? value["updated_at"] : "",
      };
    })
    .filter((ref): ref is CardRef => ref !== null);
  // 同名卡不止一张时取最新。
  refs.sort((a, b) => compareUpdatedAt(b.updatedAt, a.updatedAt));
  return refs[0] ?? null;
}

/** ISO 时间可能带不同时区偏移,能解析就按时间比,不能再按字符串比。 */
function compareUpdatedAt(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a.localeCompare(b);
}

async function fetchCard(gateway: BrainGateway, id: string): Promise<ProfileCard | null> {
  return toCard(await gateway.getJson(`/v1/cards/${encodeURIComponent(id)}`));
}

/** 先按标题搜,搜不到再看最近更新的一页卡片(刚发的卡还没进搜索索引时)。 */
async function findCardRef(gateway: BrainGateway): Promise<CardRef | null> {
  const search = (await gateway.getJson("/v1/search", {
    q: PROFILE_CARD_TITLE,
    scope: "cards",
    mode: "keyword",
    limit: 20,
  })) as { items?: unknown } | null;
  const ref = pickCardRef(search?.items);
  if (ref) return ref;
  const recent = (await gateway.getJson("/v1/cards", { offset: 0, limit: 50 })) as {
    items?: unknown;
  } | null;
  return pickCardRef(recent?.items);
}

/** 已同步的那张卡还有效就留着;搜到另一张更新的就换过去。 */
async function resolveCard(
  gateway: BrainGateway,
  pinnedId: string | null,
): Promise<ProfileCard | null> {
  const ref = await findCardRef(gateway);
  const pinned = pinnedId ? await fetchCard(gateway, pinnedId) : null;
  if (!ref || ref.id === pinnedId) return pinned;
  if (pinned && compareUpdatedAt(ref.updatedAt, pinned.updatedAt) <= 0) return pinned;
  return (await fetchCard(gateway, ref.id)) ?? pinned;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export type ProfileSyncResult =
  | "no-key"
  | "missing"
  | "unchanged"
  | "written"
  | "removed"
  | "failed";

/** 跨轮次的同步状态(连续鉴权失败次数);startProfileCardSync 持有一份。 */
export interface ProfileSyncState {
  authFailures: number;
}

/** 只删带同步标记的文件:用户自己放的同名文件不动。 */
async function removeManagedFile(filePath: string, existing: string | null): Promise<boolean> {
  if (!existing || !parseProfileMeta(existing)) return false;
  await rm(filePath, { force: true });
  return true;
}

export async function syncProfileCardOnce(deps: {
  logger: Logger;
  filePath?: string;
  keyFile?: string;
  fetch?: BrainFetch;
  state?: ProfileSyncState;
}): Promise<ProfileSyncResult> {
  const filePath = deps.filePath ?? leoProfileFilePath();
  const state = deps.state ?? { authFailures: 0 };
  const gateway = await openBrainGateway({
    ...(deps.keyFile ? { keyFile: deps.keyFile } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const existing = await readText(filePath);
  if (!gateway) {
    // key 被删了:这台 Mac 不再接第二大脑,上次同步的画像也不该再进会话。
    if (await removeManagedFile(filePath, existing)) {
      deps.logger.info("[leo/profile] brain key gone, removed synced profile");
    }
    return "no-key";
  }
  try {
    const meta = existing ? parseProfileMeta(existing) : null;
    const card = await resolveCard(gateway, meta?.id ?? null);
    state.authFailures = 0;
    if (!card) {
      if (await removeManagedFile(filePath, existing)) {
        deps.logger.info("[leo/profile] profile card gone, removed synced profile");
        return "removed";
      }
      return "missing";
    }
    const next = renderProfileFile(card);
    if (existing === next) return "unchanged";
    await writeAtomically(filePath, next);
    deps.logger.info("[leo/profile] profile synced", { version: card.version });
    return "written";
  } catch (error) {
    const status = error instanceof BrainHttpError ? error.status : null;
    if (status === 401 || status === 403) {
      state.authFailures += 1;
      if (
        state.authFailures >= AUTH_FAILURES_BEFORE_REMOVAL &&
        (await removeManagedFile(filePath, existing))
      ) {
        deps.logger.warn("[leo/profile] brain key rejected repeatedly, removed synced profile", {
          status,
        });
        return "removed";
      }
    }
    // 网络 / 网关出错:保留上一份,下一轮再试。
    deps.logger.warn("[leo/profile] sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

let timer: NodeJS.Timeout | null = null;

/** Host 抢到本机端口后调用一次(一台 Mac 只跑一份):立刻同步,之后每 30 分钟一次。 */
export function startProfileCardSync(logger: Logger): void {
  if (timer) return;
  const state: ProfileSyncState = { authFailures: 0 };
  const run = () => void syncProfileCardOnce({ logger, state });
  run();
  timer = setInterval(run, PROFILE_SYNC_INTERVAL_MS);
  timer.unref();
}

export function stopProfileCardSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
