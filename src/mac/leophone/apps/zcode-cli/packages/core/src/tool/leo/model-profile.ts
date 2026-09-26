// ============================================================
// [leo] 按模型的 agent 档位：编辑格式、Read 行号、精简档、prompt cache key
// ============================================================
// 配置来源（bootstrap/src/app/leo-agent-config.ts 负责读取与合并）：
//   ~/.leophoneagent/cli/config.json 的 "leo" 段 < 项目 zcode.json / .zcode/config.json 的 "leo" 段
//   < 环境变量 ZCODE_LEO_AGENT（同结构 JSON）。
// 形如：
//   "leo": {
//     "editMode": { "default": "replace", "models": { "*glm*": "hashline", "my-model": "replace" } },
//     "readLineNumbers": { "default": true, "models": { "*qwen*": false } },
//     "leanProfile": false,
//     "promptCacheKey": true,
//     "hashlineFamilies": true
//   }
// 模型匹配：glob（* 与 ?），大小写不敏感，匹配 modelId 或 "providerId/modelId"，按书写顺序第一个命中生效。
// 编辑格式优先级：用户 models > 内置家族（仅 hashlineFamilies=true 时:GLM / Kimi / MiniMax → hashline）> 用户 default > replace。
// 内置家族默认关:外部评测里 hashline 对这几家更好,但我们的实现还没在真实模型上跑过评测台,先量再开。
// hashline 编辑必须配 hashline Read（锚点来自 Read），所以 editMode=hashline 时 Read 行格式固定为 hashline。

export type LeoEditMode = "replace" | "hashline";
export type LeoReadLineFormat = "numbered" | "hashline" | "plain";

export interface LeoAgentSettings {
  editMode?: { default?: LeoEditMode; models?: Record<string, LeoEditMode> };
  readLineNumbers?: { default?: boolean; models?: Record<string, boolean> };
  leanProfile?: boolean;
  promptCacheKey?: boolean;
  /** 打开后 GLM / Kimi / MiniMax 家族默认用 hashline(默认关,见文件头)。 */
  hashlineFamilies?: boolean;
}

export interface LeoModelToolProfile {
  editMode: LeoEditMode;
  readLineFormat: LeoReadLineFormat;
}

export interface LeoModelIdentity {
  modelId?: string;
  providerId?: string;
}

/** hashlineFamilies=true 时这几家默认用 hashline(见 docs/mac-3.0/UPSTREAM.md 的 Leo agent 档位说明)。 */
export const LEO_DEFAULT_HASHLINE_MODEL_PATTERNS: readonly string[] = [
  "*glm*",
  "*kimi*",
  "*minimax*",
];

export function resolveLeoModelToolProfile(
  model: LeoModelIdentity | undefined,
  settings: LeoAgentSettings | undefined,
): LeoModelToolProfile {
  const editMode = resolveLeoEditMode(model, settings);
  if (editMode === "hashline") return { editMode, readLineFormat: "hashline" };
  const lineNumbers =
    matchModelSetting(model, settings?.readLineNumbers?.models) ??
    settings?.readLineNumbers?.default ??
    true;
  return { editMode, readLineFormat: lineNumbers ? "numbered" : "plain" };
}

export function resolveLeoEditMode(
  model: LeoModelIdentity | undefined,
  settings: LeoAgentSettings | undefined,
): LeoEditMode {
  const explicit = matchModelSetting(model, settings?.editMode?.models);
  if (explicit) return explicit;
  if (settings?.hashlineFamilies === true && matchesAnyPattern(model, LEO_DEFAULT_HASHLINE_MODEL_PATTERNS)) {
    return "hashline";
  }
  return settings?.editMode?.default ?? "replace";
}

function matchModelSetting<T>(
  model: LeoModelIdentity | undefined,
  patterns: Readonly<Record<string, T>> | undefined,
): T | undefined {
  if (!model || !patterns) return undefined;
  for (const [pattern, value] of Object.entries(patterns)) {
    if (matchesAnyPattern(model, [pattern])) return value;
  }
  return undefined;
}

function matchesAnyPattern(
  model: LeoModelIdentity | undefined,
  patterns: readonly string[],
): boolean {
  if (!model?.modelId) return false;
  const candidates = [model.modelId];
  if (model.providerId) candidates.push(`${model.providerId}/${model.modelId}`);
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const source = pattern
    .trim()
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[\\^$.|+()[\]{}]/u, (special) => `\\${special}`);
    })
    .join("");
  const regex = new RegExp(`^${source}$`, "iu");
  globCache.set(pattern, regex);
  return regex;
}

/**
 * 校验并收窄来自配置文件 / 环境变量的任意 JSON；非法字段丢弃（返回的 warnings 由调用方记日志），
 * 不因为一个写错的值让 agent 起不来。
 */
export function parseLeoAgentSettings(value: unknown): {
  settings: LeoAgentSettings;
  warnings: string[];
} {
  const warnings: string[] = [];
  const settings: LeoAgentSettings = {};
  if (!isRecord(value)) {
    if (value !== undefined) warnings.push("leo settings must be an object");
    return { settings, warnings };
  }

  if (value.editMode !== undefined) {
    const editMode = readModelMap(value.editMode, "editMode", isEditMode, warnings);
    if (editMode) settings.editMode = editMode;
  }
  if (value.readLineNumbers !== undefined) {
    const readLineNumbers = readModelMap(
      value.readLineNumbers,
      "readLineNumbers",
      (entry): entry is boolean => typeof entry === "boolean",
      warnings,
    );
    if (readLineNumbers) settings.readLineNumbers = readLineNumbers;
  }
  for (const key of ["leanProfile", "promptCacheKey", "hashlineFamilies"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === "boolean") settings[key] = value[key];
    else warnings.push(`leo.${key} must be a boolean`);
  }
  return { settings, warnings };
}

/** 后者覆盖前者；models 映射按键合并，后者的键排在前面（先匹配）。 */
export function mergeLeoAgentSettings(
  ...layers: ReadonlyArray<LeoAgentSettings | undefined>
): LeoAgentSettings {
  const merged: LeoAgentSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.editMode) merged.editMode = mergeModelMap(merged.editMode, layer.editMode);
    if (layer.readLineNumbers) {
      merged.readLineNumbers = mergeModelMap(merged.readLineNumbers, layer.readLineNumbers);
    }
    if (layer.leanProfile !== undefined) merged.leanProfile = layer.leanProfile;
    if (layer.promptCacheKey !== undefined) merged.promptCacheKey = layer.promptCacheKey;
    if (layer.hashlineFamilies !== undefined) merged.hashlineFamilies = layer.hashlineFamilies;
  }
  return merged;
}

function mergeModelMap<T>(
  base: { default?: T; models?: Record<string, T> } | undefined,
  next: { default?: T; models?: Record<string, T> },
): { default?: T; models?: Record<string, T> } {
  const result: { default?: T; models?: Record<string, T> } = { ...base };
  if (next.default !== undefined) result.default = next.default;
  if (next.models) result.models = { ...next.models, ...omitKeys(base?.models, next.models) };
  return result;
}

function omitKeys<T>(
  record: Record<string, T> | undefined,
  keys: Record<string, unknown>,
): Record<string, T> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key in keys)));
}

function readModelMap<T>(
  value: unknown,
  name: string,
  isValue: (entry: unknown) => entry is T,
  warnings: string[],
): { default?: T; models?: Record<string, T> } | undefined {
  // 简写："editMode": "hashline" 等价于 { "default": "hashline" }。
  if (isValue(value)) return { default: value };
  if (!isRecord(value)) {
    warnings.push(`leo.${name} must be an object`);
    return undefined;
  }
  const result: { default?: T; models?: Record<string, T> } = {};
  if (value.default !== undefined) {
    if (isValue(value.default)) result.default = value.default;
    else warnings.push(`leo.${name}.default is invalid`);
  }
  if (value.models !== undefined) {
    if (!isRecord(value.models)) {
      warnings.push(`leo.${name}.models must be an object`);
    } else {
      const models: Record<string, T> = {};
      for (const [pattern, entry] of Object.entries(value.models)) {
        if (isValue(entry)) models[pattern] = entry;
        else warnings.push(`leo.${name}.models["${pattern}"] is invalid`);
      }
      result.models = models;
    }
  }
  return result;
}

function isEditMode(value: unknown): value is LeoEditMode {
  return value === "replace" || value === "hashline";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
