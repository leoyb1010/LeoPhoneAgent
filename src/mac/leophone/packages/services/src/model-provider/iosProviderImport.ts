import { z } from "zod";
import { decodeCloakedModelId, type ModelDiscoveryApiFormat } from "@zcode/shared/model-discovery";
import {
  PROVIDER_IMPORT_LIMITS,
  type ProviderImportSkipReason,
} from "@zcode/shared/provider-import";

/**
 * [leo] 解析 LeoBot iOS「导出服务商」JSON(ProviderConfigStore.exportInstanceJSON),映射成 Mac 自定义供应商。
 *
 * - 只在 Host 内存里处理,原始 JSON 不落盘,Key 不进日志、不回传 Renderer。
 * - 规则见 docs/specs/leo-provider-import.md。
 */
const iosModelOverridesSchema = z.looseObject({
  displayName: z.string().nullish(),
  maxOutputTokens: z.number().int().positive().nullish(),
  contextWindow: z.number().int().positive().nullish(),
  modalityOverride: z.number().int().nonnegative().nullish(),
});

const iosModelSchema = z.looseObject({
  modelId: z.string().trim().min(1).max(512),
  displayName: z.string().nullish(),
  isHidden: z.boolean().nullish(),
  contextWindow: z.number().int().positive().nullish(),
  maxOutputTokens: z.number().int().positive().nullish(),
  modalityOverride: z.number().int().nonnegative().nullish(),
  overrides: iosModelOverridesSchema.nullish(),
});

export const iosProviderExportSchema = z.looseObject({
  providerType: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  credentialType: z.string().nullish(),
  models: z.array(z.unknown()).max(PROVIDER_IMPORT_LIMITS.maxModelsPerProvider).nullish(),
  apiKey: z.string().max(16_384).nullish(),
  manualOAuthToken: z.string().max(16_384).nullish(),
  isEnabled: z.boolean().nullish(),
  customBaseURL: z.string().max(2048).nullish(),
  appendV1Suffix: z.boolean().nullish(),
  customUserAgent: z.string().max(512).nullish(),
  azureMode: z.boolean().nullish(),
  secretsOmitted: z.boolean().nullish(),
});
export type IosProviderExport = z.infer<typeof iosProviderExportSchema>;

/** ModelModality.imageInput = 1 << 2(src/ios/Providers/LLMTypes.swift)。 */
const IOS_IMAGE_INPUT_BIT = 1 << 2;

export interface ImportedModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly vision?: boolean;
}

export interface MappedIosProvider {
  readonly kind: "provider";
  readonly label: string;
  readonly providerType: string;
  readonly apiType: ModelDiscoveryApiFormat;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly ImportedModel[];
}

export interface SkippedIosProvider {
  readonly kind: "skipped";
  readonly label: string;
  readonly providerType: string;
  readonly reason: ProviderImportSkipReason;
  readonly detail?: string;
}

export type IosProviderMapping = MappedIosProvider | SkippedIosProvider;

export interface ParsedImportFile {
  readonly fileName: string;
  readonly entries: readonly IosProviderMapping[];
}

/**
 * iOS 导出 Key 用 base64(utf8);旧版本是明文。与 iOS importInstanceJSON 一样:能严格解码成可打印文本就用解码值,
 * 否则按明文。明文 Key(sk-…、带 - 或 _)本身不是合法 base64,不会被误解码。
 */
export function decodeIosSecret(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed) && trimmed.length % 4 === 0) {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    const roundTrip = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/u, "");
    // 可打印 ASCII 且能原样编回,才认为是 base64;十六进制明文 Key 解出来是乱码,会落回明文。
    if (decoded && /^[\x21-\x7e]+$/u.test(decoded) && roundTrip === trimmed.replace(/=+$/u, "")) {
      return decoded;
    }
  }
  return trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function stripV1(value: string): string {
  return stripTrailingSlash(value).replace(/\/v1$/iu, "");
}

/** 与 iOS OpenAIProvider.resolvedAPIBase 一致:appendV1Suffix 缺省为 true,此时补且只补一个 /v1。 */
function withV1(base: string, appendV1Suffix: boolean | null | undefined): string {
  return appendV1Suffix === false ? stripTrailingSlash(base) : `${stripV1(base)}/v1`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveEndpoint(
  item: IosProviderExport,
): { apiType: ModelDiscoveryApiFormat; baseUrl: string } | SkippedIosProvider["reason"] {
  const custom = item.customBaseURL?.trim() || undefined;
  switch (item.providerType) {
    case "openAI":
      return {
        apiType: "openai-chat-completions",
        baseUrl: withV1(custom ?? "https://api.openai.com", item.appendV1Suffix),
      };
    case "openAIResponses":
      return {
        apiType: "openai-responses",
        baseUrl: withV1(custom ?? "https://api.openai.com", item.appendV1Suffix),
      };
    case "anthropic":
      // Mac 运行时会给 Anthropic 地址补 /v1,这里保留原样。
      return {
        apiType: "anthropic-messages",
        baseUrl: stripTrailingSlash(custom ?? "https://api.anthropic.com"),
      };
    case "openRouter":
      return {
        apiType: "openai-chat-completions",
        baseUrl: stripTrailingSlash(custom ?? "https://openrouter.ai/api/v1"),
      };
    case "xAI":
      return {
        apiType: "openai-chat-completions",
        baseUrl: stripTrailingSlash(custom ?? "https://api.x.ai/v1"),
      };
    case "gemini":
      // Mac 没有 Gemini 原生协议,走 Google 官方的 OpenAI 兼容端点;iOS 的自定义地址是原生协议地址,不沿用。
      return {
        apiType: "openai-chat-completions",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      };
    case "kimiCode":
      return {
        apiType: "openai-chat-completions",
        baseUrl: withV1(custom ?? "https://api.kimi.com/coding", true),
      };
    case "openCodeGo":
      return "opencode-go";
    default:
      return "unsupported-type";
  }
}

function mapModels(rawModels: readonly unknown[] | null | undefined): ImportedModel[] {
  const seen = new Set<string>();
  const models: ImportedModel[] = [];
  for (const raw of rawModels ?? []) {
    const parsed = iosModelSchema.safeParse(raw);
    if (!parsed.success) continue;
    const model = parsed.data;
    // 手机上从网关拉过的 ID 也可能是 claude-…-dd-<倒序> 的伪装写法,导入时一并还原。
    const id = decodeCloakedModelId(model.modelId);
    if (model.isHidden || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = model.overrides?.contextWindow ?? model.contextWindow ?? undefined;
    const maxOutput = model.overrides?.maxOutputTokens ?? model.maxOutputTokens ?? undefined;
    const modality = model.overrides?.modalityOverride ?? model.modalityOverride ?? undefined;
    models.push({
      id,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(modality === undefined ? {} : { vision: (modality & IOS_IMAGE_INPUT_BIT) !== 0 }),
    });
  }
  return models;
}

/** 单个 iOS 导出对象 → Mac 供应商(或带原因的跳过)。 */
export function mapIosProvider(item: IosProviderExport): IosProviderMapping {
  const base = { label: item.label, providerType: item.providerType };
  if (item.azureMode) return { kind: "skipped", ...base, reason: "azure" };
  const endpoint = resolveEndpoint(item);
  if (typeof endpoint === "string") return { kind: "skipped", ...base, reason: endpoint };
  if (!isHttpUrl(endpoint.baseUrl)) {
    return { kind: "skipped", ...base, reason: "invalid-base-url" };
  }
  const apiKey = decodeIosSecret(item.apiKey) ?? decodeIosSecret(item.manualOAuthToken);
  // ChatGPT / xAI / Kimi 的登录态 iOS 从不导出(刷新令牌不能两台设备共用);没有手动 token 就无从导入。
  if (item.credentialType === "oauth" && !apiKey && item.providerType !== "openRouter") {
    return { kind: "skipped", ...base, reason: "oauth-only" };
  }
  const userAgent = item.customUserAgent?.trim();
  return {
    kind: "provider",
    ...base,
    apiType: endpoint.apiType,
    baseUrl: endpoint.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(userAgent ? { headers: { "User-Agent": userAgent } } : {}),
    models: mapModels(item.models),
  };
}

/** 文件内容 → 映射结果。支持单个对象、对象数组、以及 `{ providers: [...] }` 包装。 */
export function parseIosProviderFile(fileName: string, content: string): ParsedImportFile {
  const invalid = (detail: string): ParsedImportFile => ({
    fileName,
    entries: [
      { kind: "skipped", label: fileName, providerType: "", reason: "invalid-file", detail },
    ],
  });
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return invalid("invalid JSON");
  }
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { providers?: unknown }).providers)
      ? (json as { providers: unknown[] }).providers
      : [json];
  if (list.length === 0) return invalid("empty");
  const entries = list.map((raw, index): IosProviderMapping => {
    const parsed = iosProviderExportSchema.safeParse(raw);
    if (!parsed.success) {
      const label =
        raw && typeof raw === "object" && typeof (raw as { label?: unknown }).label === "string"
          ? (raw as { label: string }).label
          : `${fileName} #${index + 1}`;
      return {
        kind: "skipped",
        label,
        providerType: "",
        reason: "invalid-file",
        detail: parsed.error.issues[0]?.path.join(".") || "invalid",
      };
    }
    return mapIosProvider(parsed.data);
  });
  return { fileName, entries };
}

function normalizeBaseUrlKey(value: string | null | undefined): string {
  return stripTrailingSlash(value ?? "").toLowerCase();
}

export interface ExistingProviderSummary {
  readonly providerId: string;
  readonly label: string;
  readonly baseUrl: string;
}

export type ImportDecision =
  | { readonly action: "create"; readonly label: string }
  | { readonly action: "update"; readonly providerId: string };

/**
 * 去重规则:同名且同 Base URL 视为同一个供应商 → 更新(合并模型、提供了 Key 才覆盖 Key);
 * 否则新建,名称冲突时像 iOS 一样追加 " (2)"、" (3)"。
 */
export function decideImport(
  mapped: Pick<MappedIosProvider, "label" | "baseUrl">,
  existing: readonly ExistingProviderSummary[],
): ImportDecision {
  const baseKey = normalizeBaseUrlKey(mapped.baseUrl);
  const match = existing.find(
    (provider) =>
      provider.label.trim() === mapped.label.trim() &&
      normalizeBaseUrlKey(provider.baseUrl) === baseKey,
  );
  if (match) return { action: "update", providerId: match.providerId };
  const labels = new Set(existing.map((provider) => provider.label.trim()));
  let label = mapped.label.trim();
  if (labels.has(label)) {
    let suffix = 2;
    while (labels.has(`${mapped.label.trim()} (${suffix})`)) suffix += 1;
    label = `${mapped.label.trim()} (${suffix})`;
  }
  return { action: "create", label };
}
