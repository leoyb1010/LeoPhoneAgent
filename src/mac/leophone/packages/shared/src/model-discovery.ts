/**
 * [leo] 「从接口获取模型」的共享协议与纯函数。
 *
 * 添加供应商时以前只能逐个手敲模型 ID,各家 ID 写法不同(claude-opus-5-5 / gpt-5.5)经常敲错。
 * 这里放 Renderer 与 Host 共用的部分:请求/响应 schema(RPC 边界做运行时校验)、展示名美化、
 * 系列分组、非对话模型识别和默认勾选规则。不含任何网络或文件 IO。
 */
import { z } from "zod";

export const modelDiscoveryApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export type ModelDiscoveryApiFormat = z.infer<typeof modelDiscoveryApiFormatSchema>;

/**
 * 已保存的供应商只传 providerId:Key 由 Host 从配置里取,不经 Renderer 往返。
 * 未保存的草稿才传 baseUrl/apiFormat/apiKey。
 */
export const modelDiscoveryRequestSchema = z.union([
  z.object({ providerId: z.string().trim().min(1) }).strict(),
  z
    .object({
      baseUrl: z.string().trim().min(1),
      apiFormat: modelDiscoveryApiFormatSchema,
      apiKey: z.string().optional(),
      templateId: z.string().optional(),
    })
    .strict(),
]);
export type ModelDiscoveryRequest = z.infer<typeof modelDiscoveryRequestSchema>;

export const discoveredModelCapabilitiesSchema = z
  .object({
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();
export type DiscoveredModelCapabilities = z.infer<typeof discoveredModelCapabilitiesSchema>;

export const discoveredModelSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    contextWindow: z.number().int().positive().optional(),
    maxOutput: z.number().int().positive().optional(),
    capabilities: discoveredModelCapabilitiesSchema.optional(),
    /** models.dev 的 release_date(YYYY-MM-DD),用于默认勾选最新几款。 */
    releaseDate: z.string().optional(),
    /** 嵌入、语音、生图等非对话模型:默认隐藏,UI「显示全部」时才列出。 */
    hidden: z.boolean().optional(),
  })
  .strict();
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

export const modelDiscoveryErrorKindSchema = z.enum([
  "auth",
  "not_supported",
  "network",
  "tls",
  "unknown",
]);
export type ModelDiscoveryErrorKind = z.infer<typeof modelDiscoveryErrorKindSchema>;

export const modelDiscoveryResultSchema = z
  .object({
    models: z.array(discoveredModelSchema),
    source: z.enum(["endpoint", "catalog", "builtin"]),
    error: z
      .object({ kind: modelDiscoveryErrorKindSchema, message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type ModelDiscoveryResult = z.infer<typeof modelDiscoveryResultSchema>;

const BRAND_TOKENS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  gemma: "Gemma",
  deepseek: "DeepSeek",
  glm: "GLM",
  qwen: "Qwen",
  qwq: "QwQ",
  kimi: "Kimi",
  moonshot: "Moonshot",
  grok: "Grok",
  llama: "Llama",
  mistral: "Mistral",
  mixtral: "Mixtral",
  codestral: "Codestral",
  minimax: "MiniMax",
  doubao: "Doubao",
  ernie: "ERNIE",
  hunyuan: "Hunyuan",
  yi: "Yi",
  phi: "Phi",
  command: "Command",
  sonar: "Sonar",
  api: "API",
  ai: "AI",
};

const DATE_SUFFIX = /[-_@](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{6})$/u;

function stripVendorPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

function formatToken(token: string): string {
  const lower = token.toLowerCase();
  const brand = BRAND_TOKENS[lower];
  if (brand) return brand;
  // 70b / 8x7b / a35b 这类参数量标记用大写 B。
  if (/^(?:\d+x)?\d+(?:\.\d+)?[bmk]$/u.test(lower) || /^a\d+b$/u.test(lower)) {
    return lower.toUpperCase();
  }
  // OpenAI 的 o3 / o4 官方写法就是小写。
  if (/^o\d/u.test(lower)) return lower;
  // v3 / k2 / r1 这类版本代号首字母大写。
  if (/^[a-z]\d/u.test(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1);
  if (/^\d/u.test(lower)) return lower;
  const brandPrefix = Object.keys(BRAND_TOKENS).find(
    (key) => key.length > 2 && lower.startsWith(key) && /^\d/u.test(lower.slice(key.length)),
  );
  // qwen3 / gemma3 这类品牌直接接版本号。
  if (brandPrefix) return `${BRAND_TOKENS[brandPrefix]}${lower.slice(brandPrefix.length)}`;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * 模型 ID → 人类可读名。只在没有 models.dev 条目时兜底:
 * `claude-opus-5-5` → `Claude Opus 5.5`,`claude-haiku-4-5-20251001` → `Claude Haiku 4.5`,
 * `gpt-5.5` → `GPT-5.5`。已经带大写的 ID(如 `GLM-5.3`、`DeepSeek-V3`)视为厂商自定写法,原样保留。
 */
export function prettifyModelId(modelId: string): string {
  const base = stripVendorPrefix(modelId);
  if (!base) return modelId;
  if (/[A-Z]/u.test(base)) return base;
  const withoutDate = base.replace(DATE_SUFFIX, "") || base;
  const tokens = withoutDate.split(/[-_\s]+/u).filter(Boolean);
  if (tokens.length === 0) return base;
  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === "gpt" && index + 1 < tokens.length) {
      // GPT 系列官方写法是连字符:GPT-5.5 / GPT-4o。
      parts.push(`GPT-${tokens[index + 1]!.toLowerCase()}`);
      index += 1;
      continue;
    }
    // claude-opus-5-5 的 5-5 是 5.5;只合并 1~2 位的纯数字段,避免把日期、参数量拼进去。
    if (/^\d{1,2}$/u.test(token) && parts.length > 0 && /^\d+(?:\.\d+)*$/u.test(parts.at(-1)!)) {
      parts[parts.length - 1] = `${parts.at(-1)!}.${token}`;
      continue;
    }
    parts.push(formatToken(token));
  }
  return parts.join(" ");
}

/**
 * 分组用的系列键:claude-opus / claude-sonnet / gpt / openai-o / gemini / deepseek ……
 * 识别不了的取第一个词。
 */
export function resolveModelFamily(modelId: string): string {
  const lower = stripVendorPrefix(modelId).toLowerCase();
  if (lower.startsWith("claude")) {
    const tier = /(opus|sonnet|haiku)/u.exec(lower)?.[1];
    return tier ? `claude-${tier}` : "claude";
  }
  if (/^(?:chat)?gpt/u.test(lower)) return "gpt";
  if (/^o\d/u.test(lower)) return "openai-o";
  const head = /^[a-z]+/u.exec(lower)?.[0];
  return head || lower.split(/[-_.]/u)[0] || lower;
}

const NON_CHAT_PATTERN =
  /(?:^|[-_/.])(?:embed|embedding|embeddings|tts|whisper|transcribe|transcription|speech|moderation|rerank|reranker|dall-e|imagen|image|sora|realtime|audio|davinci|babbage|search-preview)(?:$|[-_/.\d])|text-embedding|gpt-image|omni-moderation/u;

/** 嵌入、语音、生图、审核等不能用于对话的模型。 */
export function isLikelyNonChatModel(modelId: string): boolean {
  return NON_CHAT_PATTERN.test(modelId.toLowerCase());
}

function compareVersionDesc(left: string, right: string): number {
  return right.localeCompare(left, "en", { numeric: true, sensitivity: "base" });
}

/** 新的在前:有 release_date 按日期,否则按 ID 里的版本号自然序。 */
export function compareModelsNewestFirst(
  left: Pick<DiscoveredModel, "id" | "releaseDate">,
  right: Pick<DiscoveredModel, "id" | "releaseDate">,
): number {
  if (left.releaseDate && right.releaseDate && left.releaseDate !== right.releaseDate) {
    return right.releaseDate.localeCompare(left.releaseDate);
  }
  // 带日期后缀的快照排在别名之后,同名时默认勾选别名。
  const leftDated = DATE_SUFFIX.test(left.id);
  const rightDated = DATE_SUFFIX.test(right.id);
  const leftBase = left.id.replace(DATE_SUFFIX, "");
  const rightBase = right.id.replace(DATE_SUFFIX, "");
  if (leftBase === rightBase && leftDated !== rightDated) return leftDated ? 1 : -1;
  return compareVersionDesc(leftBase, rightBase) || compareVersionDesc(left.id, right.id);
}

/**
 * 默认勾选:每个系列取最新的 perFamily 个(同展示名只取一个),总数不超过 maxTotal。
 * 已添加的不会出现在返回值里。
 */
export function selectDefaultDiscoveredModels(
  models: readonly DiscoveredModel[],
  existingIds: ReadonlySet<string>,
  options: { readonly perFamily?: number; readonly maxTotal?: number } = {},
): string[] {
  const perFamily = options.perFamily ?? 2;
  const maxTotal = options.maxTotal ?? 10;
  const byFamily = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    if (model.hidden || existingIds.has(model.id)) continue;
    const family = resolveModelFamily(model.id);
    byFamily.set(family, [...(byFamily.get(family) ?? []), model]);
  }
  const picked: string[] = [];
  for (const familyModels of byFamily.values()) {
    const names = new Set<string>();
    let count = 0;
    for (const model of [...familyModels].sort(compareModelsNewestFirst)) {
      if (count >= perFamily) break;
      if (names.has(model.displayName)) continue;
      names.add(model.displayName);
      picked.push(model.id);
      count += 1;
    }
  }
  return picked.slice(0, maxTotal);
}

/** 刷新对比:接口新出现的、以及本地有但接口已不再列出的模型。 */
export function diffDiscoveredModels(
  discovered: readonly Pick<DiscoveredModel, "id">[],
  existingIds: readonly string[],
): { readonly added: string[]; readonly removed: string[] } {
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const existing = new Set(existingIds);
  return {
    added: [...discoveredIds].filter((id) => !existing.has(id)),
    removed: existingIds.filter((id) => !discoveredIds.has(id)),
  };
}

const LOCAL_HOST_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|.+\.local)$/iu;

/** Ollama / LM Studio 这类本机或局域网 `.local` 端点,允许不填 API Key。 */
export function isKeylessLocalBaseUrl(baseUrl: string | null | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  try {
    return LOCAL_HOST_PATTERN.test(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

/**
 * 发现/导入的模型按「智能配置」添加时的稀疏覆盖:只写确切知道的上下文窗口、最大输出和图片输入,
 * 其余字段继续跟随推荐规则。结构与 ModelConfigObject 的子集一致。
 */
export function buildRecommendedModelConfigPatch(input: {
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly vision?: boolean;
}): {
  properties?: { contextWindow?: number; inputFormat?: { supportsImage: boolean } };
  optionSpecs?: { maxOutputTokens: { max: number } };
} {
  const properties = {
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.vision === undefined ? {} : { inputFormat: { supportsImage: input.vision } }),
  };
  return {
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(input.maxOutput ? { optionSpecs: { maxOutputTokens: { max: input.maxOutput } } } : {}),
  };
}
